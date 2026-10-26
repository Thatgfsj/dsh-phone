package com.dafeiyu.shell;

import android.app.Activity;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.content.pm.ResolveInfo;
import android.graphics.Color;
import android.graphics.drawable.Drawable;
import android.os.Bundle;
import android.text.Editable;
import android.text.TextWatcher;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.widget.AdapterView;
import android.widget.BaseAdapter;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.GridView;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.TextView;

import java.text.Collator;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Comparator;
import java.util.List;
import java.util.Locale;

/**
 * 应用抽屉（issue #99）：首页上滑打开；4 列应用网格（图标+名称），点击启动；搜索过滤；返回关闭。
 * 深色半透明背景，可滚动；没有可启动应用时显示空态提示。
 */
public class DrawerActivity extends Activity {
    private final List<AppEntry> allApps = new ArrayList<>();
    private final List<AppEntry> visibleApps = new ArrayList<>();
    private AppAdapter adapter;
    private TextView emptyView;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        loadApps();

        FrameLayout root = new FrameLayout(this);
        root.setBackgroundColor(Color.parseColor("#F0101418"));

        LinearLayout column = new LinearLayout(this);
        column.setOrientation(LinearLayout.VERTICAL);
        column.setPadding(dp(12), dp(20), dp(12), dp(8));
        root.addView(column, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));

        EditText search = new EditText(this);
        search.setHint("搜索应用");
        search.setSingleLine(true);
        search.setTextColor(Color.WHITE);
        search.setHintTextColor(Color.parseColor("#99FFFFFF"));
        search.setBackgroundColor(Color.parseColor("#22FFFFFF"));
        column.addView(search, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));

        GridView grid = new GridView(this);
        grid.setNumColumns(4);
        grid.setHorizontalSpacing(dp(8));
        grid.setVerticalSpacing(dp(16));
        grid.setPadding(0, dp(16), 0, dp(16));
        grid.setClipToPadding(false);
        grid.setVerticalScrollBarEnabled(true);
        adapter = new AppAdapter();
        grid.setAdapter(adapter);
        grid.setOnItemClickListener(new AdapterView.OnItemClickListener() {
            @Override
            public void onItemClick(AdapterView<?> parent, View view, int position, long id) {
                launch(visibleApps.get(position));
            }
        });
        column.addView(grid, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f));

        emptyView = new TextView(this);
        emptyView.setText("没有可启动的应用");
        emptyView.setTextColor(Color.parseColor("#99FFFFFF"));
        emptyView.setGravity(Gravity.CENTER);
        emptyView.setVisibility(View.GONE);
        column.addView(emptyView, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));

        search.addTextChangedListener(new TextWatcher() {
            @Override
            public void beforeTextChanged(CharSequence s, int start, int count, int after) {}

            @Override
            public void onTextChanged(CharSequence s, int start, int before, int count) {
                filter(s == null ? "" : s.toString());
            }

            @Override
            public void afterTextChanged(Editable s) {}
        });

        setContentView(root);
        filter("");
    }

    private int dp(int value) {
        return Math.round(getResources().getDisplayMetrics().density * value);
    }

    private void loadApps() {
        PackageManager pm = getPackageManager();
        Intent intent = new Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LAUNCHER);
        List<ResolveInfo> resolved = pm.queryIntentActivities(intent, 0);
        Collator collator = Collator.getInstance(Locale.CHINA);
        for (ResolveInfo info : resolved) {
            if (info.activityInfo == null) continue;
            String pkg = info.activityInfo.packageName;
            if (getPackageName().equals(pkg)) continue;
            CharSequence label = info.loadLabel(pm);
            AppEntry entry = new AppEntry(
                    label == null ? pkg : label.toString(),
                    info.loadIcon(pm),
                    pm.getLaunchIntentForPackage(pkg));
            if (entry.launchIntent == null) continue;
            allApps.add(entry);
        }
        Collections.sort(allApps, new Comparator<AppEntry>() {
            @Override
            public int compare(AppEntry a, AppEntry b) {
                return collator.compare(a.label, b.label);
            }
        });
    }

    private void filter(String query) {
        visibleApps.clear();
        String needle = query.trim().toLowerCase(Locale.ROOT);
        for (AppEntry entry : allApps) {
            if (needle.isEmpty() || entry.label.toLowerCase(Locale.ROOT).contains(needle)) {
                visibleApps.add(entry);
            }
        }
        adapter.notifyDataSetChanged();
        emptyView.setVisibility(visibleApps.isEmpty() ? View.VISIBLE : View.GONE);
    }

    private void launch(AppEntry entry) {
        try {
            Intent intent = new Intent(entry.launchIntent);
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_RESET_TASK_IF_NEEDED);
            startActivity(intent);
            finish();
        } catch (Exception ignored) {
            // 单个应用启动失败不影响抽屉本身
        }
    }

    private static final class AppEntry {
        final String label;
        final Drawable icon;
        final Intent launchIntent;

        AppEntry(String label, Drawable icon, Intent launchIntent) {
            this.label = label;
            this.icon = icon;
            this.launchIntent = launchIntent;
        }
    }

    private final class AppAdapter extends BaseAdapter {
        @Override
        public int getCount() {
            return visibleApps.size();
        }

        @Override
        public Object getItem(int position) {
            return visibleApps.get(position);
        }

        @Override
        public long getItemId(int position) {
            return position;
        }

        @Override
        public View getView(int position, View convertView, ViewGroup parent) {
            LinearLayout cell;
            ImageView icon;
            TextView label;
            if (convertView == null) {
                cell = new LinearLayout(DrawerActivity.this);
                cell.setOrientation(LinearLayout.VERTICAL);
                cell.setGravity(Gravity.CENTER_HORIZONTAL);
                icon = new ImageView(DrawerActivity.this);
                int size = dp(52);
                cell.addView(icon, new LinearLayout.LayoutParams(size, size));
                label = new TextView(DrawerActivity.this);
                label.setTextColor(Color.WHITE);
                label.setTextSize(12);
                label.setGravity(Gravity.CENTER);
                label.setMaxLines(2);
                label.setEllipsize(android.text.TextUtils.TruncateAt.END);
                LinearLayout.LayoutParams labelParams = new LinearLayout.LayoutParams(
                        ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
                labelParams.topMargin = dp(6);
                cell.addView(label, labelParams);
                cell.setTag(new Object[]{icon, label});
            } else {
                cell = (LinearLayout) convertView;
                Object[] tags = (Object[]) cell.getTag();
                icon = (ImageView) tags[0];
                label = (TextView) tags[1];
            }
            AppEntry entry = visibleApps.get(position);
            icon.setImageDrawable(entry.icon);
            label.setText(entry.label);
            return cell;
        }
    }
}
