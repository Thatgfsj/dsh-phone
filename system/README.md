# 肥鱼手机定制层（system/）

把 Android 实例变成「肥鱼手机」：中文系统 + 空白桌面（无图标/widget）+ 两张壁纸轮换 + 去掉 YouTube。
面向 `system-images;android-34;google_apis;x86_64` + AVD `medium_phone`（1080x2400 @420dpi）。
本目录由 issue #87 引入，**插件本身不需要它**；它是可复现的「手机换肤」工具集。

## 目录

| 路径 | 说明 |
|---|---|
| `wallpapers/111.png`、`wallpapers/222.png` | 用户提供的壁纸（压缩裁切到 720x1280） |
| `feiyu-shell/` | 极简空白 HOME app 源码（Java）+ `build.sh` + 构建好的 `feiyu-shell.apk` |
| `provision-device.sh` | 一键定制/重复执行（幂等）：壁纸、装 app、设 HOME、删 YouTube、中文、重启、校验、截图 |
| `avd-config.ini` | 推荐 AVD 配置（device profile `medium_phone` 与关键项） |

## 来源与许可

- **壁纸**：用户提供，原文件路径
  `~/Downloads/111.png`、`~/Downloads/222.png`（由用户确认可用）；仓库内为 720x1280 压缩版
  （`ffmpeg -vf "scale=720:1280:force_original_aspect_ratio=increase,crop=720:1280"`）。
  壁纸版权归用户/原作者，仅随本项目一起分发，不单独授权。
- **系统镜像**：Google Android SDK（`android-34;google_apis;x86_64`，Apache-2.0/Google 条款），
  **不提交镜像、AVD 目录或快照**；`avd-config.ini` 只是配置模板。
- **app / 脚本 / 本 README**：MIT（与本仓库一致）。
- 空白桌面 app 包名 `com.dafeiyu.shell`，不依赖 Play 服务/AndroidX，只用 Android Framework API（minSdk 30 / target 34）。

## 构建 APK（可复现）

需要 JDK 17 + Android SDK（build-tools 34、platforms/android-34）：

    system/feiyu-shell/build.sh
    # 产物：system/feiyu-shell/feiyu-shell.apk（入库）
    # 中间产物 system/feiyu-shell/build/（含 debug.keystore）已在 .gitignore

构建流程：`aapt2 link`（manifest + assets 壁纸）→ `javac` → `d8` → 把 `classes.dex` 打进 APK →
`zipalign` → `apksigner sign`（debug keystore 每次本地生成，不入库）。

## 一键定制（幂等）

    system/provision-device.sh              # 默认 emulator-5554
    system/provision-device.sh emulator-5556
    REBOOT=0 system/provision-device.sh     # 调试时跳过重启

脚本步骤：`adb root` → push 壁纸到 `/sdcard/Pictures/Feiyu/` → `install -r` APK →
`cmd package set-home-activity com.dafeiyu.shell/.ShellActivity`（失败回退 `pm disable-user
com.google.android.apps.nexuslauncher`）→ `pm uninstall --user 0 com.google.android.youtube` →
`setprop persist.sys.locale zh-CN`（+ language/country）→ `reboot` → 等 `sys.boot_completed=1` →
校验 locale/包/默认 HOME/wm size → 截图到 `/tmp/feiyu-*.png`。
**会重启设备**（issue #87 已获用户批准）；执行前确认没有其他人在用该实例。

## 应用抽屉（issue #99）

首页保持空白（无图标/widget）。**从屏幕底部上滑**（swipe up / fling）打开应用抽屉：

- 4 列网格：PackageManager 的 MAIN/LAUNCHER 应用（排除肥鱼桌面自身），图标 + 中文名称，可滚动；
- 点击图标启动应用；抽屉为深色半透明；顶部搜索框可按名称过滤；
- 返回键关闭抽屉回到空白首页；没有可启动应用时显示「没有可启动的应用」；
- adb 验证：`adb shell input swipe 540 2000 540 800 300`（1080x2400 屏）→ 截图；`uiautomator dump` 可读控件文本。

## 壁纸切换（app 内 / adb 广播）

- 默认开机后由 BootReceiver 设置壁纸，之后**每 10 分钟**自动切换一次（可通过广播改/关）；
- 回到桌面（HomeActivity.onResume）时若距上次设置 >30s，会切到另一张（避免开机连翻两张）；
- adb 立即控制（`SET_WALLPAPER` 用于验收）：

      adb shell am broadcast -a com.dafeiyu.shell.SWITCH_WALLPAPER
      adb shell am broadcast -a com.dafeiyu.shell.SET_WALLPAPER --ei index 0   # 111
      adb shell am broadcast -a com.dafeiyu.shell.SET_WALLPAPER --ei index 1   # 222
      adb shell am broadcast -a com.dafeiyu.shell.SET_INTERVAL --ei minutes 0  # 关闭自动切换
      adb shell am broadcast -a com.dafeiyu.shell.SET_INTERVAL --ei minutes 5  # 改为 5 分钟

## 验收记录（#87，在当前 emulator-5554 实测）

环境：emulator 37.2.12 / android-34 google_apis x86_64 / medium_phone（1080x2400 @420dpi）。
执行 `system/provision-device.sh` 后重启并截图，结果见 PR #87 与 `docs/verification.md` 的
「肥鱼手机定制」小节（截图路径 `/tmp/feiyu-*.png`）。
