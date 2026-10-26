package com.dafeiyu.shell;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.util.Log;

/** 开机/应用更新后：设置壁纸并重排每 10 分钟切换。 */
public class BootReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context context, Intent intent) {
        String action = intent == null ? "" : intent.getAction();
        Log.i(WallpaperController.TAG, "boot receiver: " + action);
        WallpaperController.onBoot(context);
    }
}
