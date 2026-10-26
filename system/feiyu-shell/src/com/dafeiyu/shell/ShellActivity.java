package com.dafeiyu.shell;

import android.app.Activity;
import android.os.Bundle;
import android.view.ViewGroup;
import android.widget.FrameLayout;

/**
 * 空白 HOME：只显示壁纸 + 状态栏/导航栏，不渲染任何图标/widget。
 * 回首页时（与上次设置间隔 > 30s）交替切换两张壁纸；间隔内避免开机时连续翻转。
 */
public class ShellActivity extends Activity {
    private static final long MIN_SWITCH_GAP_MS = 30_000L;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        FrameLayout root = new FrameLayout(this);
        root.setLayoutParams(new ViewGroup.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        setContentView(root);
        getWindow().setBackgroundDrawableResource(android.R.color.transparent);
        getWindow().addFlags(android.view.WindowManager.LayoutParams.FLAG_SHOW_WALLPAPER);
    }

    @Override
    protected void onResume() {
        super.onResume();
        WallpaperController.maybeAdvanceOnHome(this, MIN_SWITCH_GAP_MS);
    }
}
