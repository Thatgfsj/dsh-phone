package com.dafeiyu.shell;

import android.app.Activity;
import android.content.Intent;
import android.os.Bundle;
import android.view.GestureDetector;
import android.view.MotionEvent;
import android.view.ViewGroup;
import android.widget.FrameLayout;

/**
 * 空白 HOME：只显示壁纸 + 状态栏/导航栏，不渲染任何图标/widget。
 * 上滑（swipe up / fling）打开应用抽屉 DrawerActivity；返回键关闭抽屉回空白首页（issue #99）。
 * 回首页时（与上次设置间隔 > 30s）交替切换两张壁纸；间隔内避免开机时连续翻转。
 */
public class ShellActivity extends Activity {
    private static final long MIN_SWITCH_GAP_MS = 30_000L;
    /** 上滑判定阈值（像素）与 fling 速度下限。 */
    private static final int SWIPE_UP_THRESHOLD_PX = 140;
    private static final int SWIPE_UP_VELOCITY = 300;

    private GestureDetector gestureDetector;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        FrameLayout root = new FrameLayout(this);
        root.setLayoutParams(new ViewGroup.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        setContentView(root);
        getWindow().setBackgroundDrawableResource(android.R.color.transparent);
        getWindow().addFlags(android.view.WindowManager.LayoutParams.FLAG_SHOW_WALLPAPER);

        gestureDetector = new GestureDetector(this, new GestureDetector.SimpleOnGestureListener() {
            @Override
            public boolean onFling(MotionEvent start, MotionEvent end, float velocityX, float velocityY) {
                if (start == null || end == null) return false;
                float deltaY = start.getY() - end.getY();
                if (deltaY > SWIPE_UP_THRESHOLD_PX && Math.abs(velocityY) > SWIPE_UP_VELOCITY) {
                    openDrawer();
                    return true;
                }
                return false;
            }
        });
        root.setOnTouchListener(new android.view.View.OnTouchListener() {
            private float downY = Float.NaN;

            @Override
            public boolean onTouch(android.view.View view, MotionEvent event) {
                boolean handled = gestureDetector.onTouchEvent(event);
                switch (event.getActionMasked()) {
                    case MotionEvent.ACTION_DOWN:
                        downY = event.getY();
                        break;
                    case MotionEvent.ACTION_UP:
                        if (!Float.isNaN(downY) && downY - event.getY() > SWIPE_UP_THRESHOLD_PX) {
                            openDrawer();
                            handled = true;
                        }
                        downY = Float.NaN;
                        break;
                    case MotionEvent.ACTION_CANCEL:
                        downY = Float.NaN;
                        break;
                    default:
                        break;
                }
                return true; // 必须对 DOWN 返回 true 才能继续收到 MOVE/UP
            }
        });
    }

    private void openDrawer() {
        try {
            startActivity(new Intent(this, DrawerActivity.class));
        } catch (Exception ignored) {
            // 抽屉异常不影响空白首页
        }
    }

    @Override
    protected void onResume() {
        super.onResume();
        WallpaperController.maybeAdvanceOnHome(this, MIN_SWITCH_GAP_MS);
    }
}
