package com.dafeiyu.shell;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.util.Log;

/**
 * adb 控制：
 *   adb shell am broadcast -a com.dafeiyu.shell.SWITCH_WALLPAPER            # 立即切另一张
 *   adb shell am broadcast -a com.dafeiyu.shell.SET_WALLPAPER --ei index 0 # 指定 111(index=0)/222(index=1)
 *   adb shell am broadcast -a com.dafeiyu.shell.SET_INTERVAL --ei minutes 0 # 关闭自动切换（或改分钟数）
 */
public class SwitchReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context context, Intent intent) {
        String action = intent == null ? "" : intent.getAction();
        Log.i(WallpaperController.TAG, "switch receiver: " + action);
        if (WallpaperController.ACTION_SET.equals(action)) {
            int index = intent.getIntExtra(WallpaperController.EXTRA_INDEX, 0);
            WallpaperController.setWallpaper(context, index);
            return;
        }
        if (WallpaperController.ACTION_SET_INTERVAL.equals(action)) {
            int minutes = intent.getIntExtra(
                    WallpaperController.EXTRA_MINUTES, WallpaperController.DEFAULT_INTERVAL_MIN);
            context.getSharedPreferences(WallpaperController.PREFS, Context.MODE_PRIVATE)
                    .edit().putInt(WallpaperController.KEY_INTERVAL_MIN, minutes).apply();
            WallpaperController.schedule(context, minutes);
            return;
        }
        if (WallpaperController.ACTION_SWITCH.equals(action)) {
            WallpaperController.switchNext(context);
            return;
        }
        WallpaperController.switchNext(context);
    }
}
