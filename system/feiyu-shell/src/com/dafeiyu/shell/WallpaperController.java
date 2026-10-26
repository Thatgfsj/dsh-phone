package com.dafeiyu.shell;

import android.app.AlarmManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.util.Log;
import android.app.WallpaperManager;

import java.io.IOException;
import java.io.InputStream;

/**
 * 壁纸轮换（两张内置 assets：111.png / 222.png）。
 * - 默认每 10 分钟切换一次（SET_INTERVAL 可改，0=关闭）；
 * - adb 广播 SET_WALLPAPER(index 0/1) 立即指定，SWITCH_WALLPAPER 立即切另一张；
 * - BootReceiver 开机设置一次。
 */
public final class WallpaperController {
    public static final String TAG = "FeiyuShell";
    public static final String PREFS = "feiyu_shell";
    public static final String KEY_INDEX = "wallpaper_index";
    public static final String KEY_LAST_SET = "last_set_at";
    public static final String KEY_INTERVAL_MIN = "interval_minutes";
    public static final int DEFAULT_INTERVAL_MIN = 10;

    public static final String ACTION_SWITCH = "com.dafeiyu.shell.SWITCH_WALLPAPER";
    public static final String ACTION_SET = "com.dafeiyu.shell.SET_WALLPAPER";
    public static final String ACTION_SET_INTERVAL = "com.dafeiyu.shell.SET_INTERVAL";
    public static final String EXTRA_INDEX = "index";
    public static final String EXTRA_MINUTES = "minutes";

    private static final String[] ASSETS = {"111.png", "222.png"};

    private WallpaperController() {}

    private static SharedPreferences prefs(Context context) {
        return context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    public static int currentIndex(Context context) {
        return prefs(context).getInt(KEY_INDEX, 0);
    }

    public static int intervalMinutes(Context context) {
        return prefs(context).getInt(KEY_INTERVAL_MIN, DEFAULT_INTERVAL_MIN);
    }

    /** 设置指定壁纸（index 归一化到 0/1），并记录 last_set。 */
    public static void setWallpaper(Context context, int index) {
        int normalized = ((index % ASSETS.length) + ASSETS.length) % ASSETS.length;
        try (InputStream stream = context.getAssets().open(ASSETS[normalized])) {
            Bitmap bitmap = BitmapFactory.decodeStream(stream);
            if (bitmap == null) {
                Log.w(TAG, "decode wallpaper failed: " + ASSETS[normalized]);
                return;
            }
            WallpaperManager manager = WallpaperManager.getInstance(context);
            try {
                manager.setBitmap(bitmap, null, true, WallpaperManager.FLAG_SYSTEM);
            } finally {
                bitmap.recycle();
            }
            prefs(context).edit()
                    .putInt(KEY_INDEX, normalized)
                    .putLong(KEY_LAST_SET, System.currentTimeMillis())
                    .apply();
            Log.i(TAG, "wallpaper set: " + ASSETS[normalized]);
        } catch (IOException | SecurityException e) {
            Log.w(TAG, "set wallpaper failed: " + e);
        }
    }

    /** 切到另一张并重排下一次定时切换。 */
    public static void switchNext(Context context) {
        setWallpaper(context, currentIndex(context) + 1);
        schedule(context, intervalMinutes(context));
    }

    /** 回到首页时交替（间隔 MIN_SWITCH_GAP_MS 内不重复切，避免开机时连翻两张）。 */
    public static void maybeAdvanceOnHome(Context context, long minGapMs) {
        long last = prefs(context).getLong(KEY_LAST_SET, 0L);
        if (System.currentTimeMillis() - last < minGapMs) return;
        setWallpaper(context, currentIndex(context) + 1);
    }

    /** 开机：首次无记录时用 111，否则切换；随后重排定时。 */
    public static void onBoot(Context context) {
        if (!prefs(context).contains(KEY_INDEX)) {
            setWallpaper(context, 0);
        } else {
            setWallpaper(context, currentIndex(context) + 1);
        }
        schedule(context, intervalMinutes(context));
    }

    /** 定时切换（AlarmManager 重复广播 ACTION_SWITCH；0 分钟=关闭）。 */
    public static void schedule(Context context, int minutes) {
        AlarmManager alarm = (AlarmManager) context.getSystemService(Context.ALARM_SERVICE);
        if (alarm == null) return;
        PendingIntent pending = pendingSwitch(context);
        alarm.cancel(pending);
        if (minutes <= 0) {
            Log.i(TAG, "auto switch disabled");
            return;
        }
        long intervalMs = minutes * 60_000L;
        try {
            alarm.setRepeating(AlarmManager.ELAPSED_REALTIME_WAKEUP,
                    android.os.SystemClock.elapsedRealtime() + intervalMs,
                    intervalMs, pending);
            Log.i(TAG, "auto switch every " + minutes + " min");
        } catch (SecurityException e) {
            Log.w(TAG, "schedule failed: " + e);
        }
    }

    private static PendingIntent pendingSwitch(Context context) {
        Intent intent = new Intent(ACTION_SWITCH);
        intent.setClassName(context, SwitchReceiver.class.getName());
        return PendingIntent.getBroadcast(context, 1001, intent,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }
}
