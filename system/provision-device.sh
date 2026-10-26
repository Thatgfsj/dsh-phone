#!/usr/bin/env bash
# 肥鱼手机一键定制（幂等）：壁纸 + 空白 HOME + 中文 + 去 YouTube。
#
# 用法：
#   system/provision-device.sh [serial]        # 默认 emulator-5554
#   REBOOT=0 system/provision-device.sh        # 跳过重启（调试用）
#
# 前置：adb（Android SDK platform-tools）、设备已 root（emulator google_apis 支持 adb root）。
# 注意：会重启设备（用户已批准）；执行前确认没有其他人在使用该实例。
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ADB="${ADB:-$HOME/Android/Sdk/platform-tools/adb}"
SERIAL="${1:-emulator-5554}"
APP_ID="com.dafeiyu.shell"
HOME_ACTIVITY="$APP_ID/.ShellActivity"
APK="$HERE/feiyu-shell/feiyu-shell.apk"
WALLPAPER_DIR="/sdcard/Pictures/Feiyu"
SHOT_DIR="${SHOT_DIR:-/tmp}"

adbcmd() { "$ADB" -s "$SERIAL" "$@"; }
step() { echo "[provision] $*"; }
try() { "$@" >/dev/null 2>&1 || true; }

step "设备检查: $SERIAL"
adbcmd wait-for-device
[ -f "$APK" ] || { echo "[provision] 缺少 $APK，先运行 system/feiyu-shell/build.sh" >&2; exit 1; }

step "adb root（改 locale / 壁纸需要）"
try adbcmd root
adbcmd wait-for-device
for _ in $(seq 1 20); do
  [ "$(adbcmd shell id -u 2>/dev/null | tr -d '\r')" = "0" ] && break
  sleep 1
done

step "推送壁纸到 $WALLPAPER_DIR（应用内也内置一份）"
adbcmd shell mkdir -p "$WALLPAPER_DIR"
adbcmd push "$HERE/wallpapers/111.png" "$WALLPAPER_DIR/111.png" >/dev/null
adbcmd push "$HERE/wallpapers/222.png" "$WALLPAPER_DIR/222.png" >/dev/null

step "安装/更新 $APP_ID"
if ! adbcmd install -r -g "$APK" >/dev/null 2>&1; then
  step "签名/版本冲突，卸载旧 app 后重装"
  try adbcmd uninstall "$APP_ID"
  adbcmd install -g "$APK" >/dev/null
fi

step "设置默认 HOME（优先 set-home-activity，回退禁用 NexusLauncher）"
if ! adbcmd shell cmd package set-home-activity --user 0 "$HOME_ACTIVITY" >/dev/null 2>&1; then
  try adbcmd shell cmd package set-home-activity "$HOME_ACTIVITY"
fi
if ! adbcmd shell cmd package resolve-activity -c android.intent.category.HOME 2>/dev/null | grep -q "$APP_ID"; then
  step "set-home-activity 未生效，回退：pm disable-user NexusLauncher"
  try adbcmd shell pm disable-user --user 0 com.google.android.apps.nexuslauncher
fi

step "卸载 YouTube（只删 com.google.android.youtube；YouTube Music 保留）"
try adbcmd shell pm uninstall --user 0 com.google.android.youtube

step "系统语言 zh-CN"
adbcmd shell setprop persist.sys.locale zh-CN
adbcmd shell setprop persist.sys.language zh
adbcmd shell setprop persist.sys.country CN

if [ "${REBOOT:-1}" = "1" ]; then
  step "重启设备并等待 boot_completed（通常 30–60s）"
  try adbcmd reboot
  sleep 5
  adbcmd wait-for-device
  for _ in $(seq 1 180); do
    [ "$(adbcmd shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')" = "1" ] && break
    sleep 1
  done
  sleep 3
fi

step "校验"
LOCALE="$(adbcmd shell getprop persist.sys.locale | tr -d '\r')"
BOOT="$(adbcmd shell getprop sys.boot_completed | tr -d '\r')"
PKG="$(adbcmd shell pm list packages "$APP_ID" | tr -d '\r')"
HOME_RESOLVED="$(adbcmd shell cmd package resolve-activity --brief -a android.intent.action.MAIN -c android.intent.category.HOME 2>/dev/null | tr -d '\r' | tail -1)"
SIZE="$(adbcmd shell wm size | tr -d '\r')"
YT="$(adbcmd shell pm list packages com.google.android.youtube | tr -d '\r' || true)"
YTM="$(adbcmd shell pm list packages com.google.android.apps.youtube.music | tr -d '\r' || true)"
if [ -n "$YT" ]; then
  step "YouTube 仍存在，重试卸载"
  try adbcmd shell pm uninstall --user 0 com.google.android.youtube
  YT="$(adbcmd shell pm list packages com.google.android.youtube | tr -d '\r' || true)"
fi
echo "  locale=$LOCALE  boot_completed=$BOOT"
echo "  package=$PKG  home=$HOME_RESOLVED  wm=$SIZE"
echo "  youtube=${YT:-<none>}  youtube-music=${YTM:-<none>}"

step "唤醒并确保首页可见后再截图"
adbcmd shell input keyevent KEYCODE_WAKEUP >/dev/null 2>&1 || true
adbcmd shell am start -a android.intent.action.MAIN -c android.intent.category.HOME >/dev/null 2>&1 || true
for _ in $(seq 1 20); do
  adbcmd shell dumpsys window 2>/dev/null | grep -q "mCurrentFocus.*$APP_ID" && break
  sleep 1
done
sleep 2
STAMP="$(date +%H%M%S)"
SHOT1="$SHOT_DIR/feiyu-home-111-$STAMP.png"
adbcmd exec-out screencap -p > "$SHOT1"
echo "  screenshot=$SHOT1  (壁纸 111 / 空白首页)"
adbcmd shell am broadcast -n com.dafeiyu.shell/.SwitchReceiver -a com.dafeiyu.shell.SET_WALLPAPER --ei index 1 >/dev/null
sleep 2
SHOT2="$SHOT_DIR/feiyu-wallpaper-222-$STAMP.png"
adbcmd exec-out screencap -p > "$SHOT2"
echo "  screenshot=$SHOT2  (壁纸 222)"
step "中文界面截图（系统设置）"
adbcmd shell am start -a android.settings.SETTINGS >/dev/null 2>&1 || true
sleep 3
SHOT3="$SHOT_DIR/feiyu-settings-zh-$STAMP.png"
adbcmd exec-out screencap -p > "$SHOT3"
echo "  screenshot=$SHOT3  (中文设置界面)"
echo "  locale=$LOCALE"
adbcmd shell am broadcast -n com.dafeiyu.shell/.SwitchReceiver -a com.dafeiyu.shell.SET_WALLPAPER --ei index 0 >/dev/null
adbcmd shell am start -a android.intent.action.MAIN -c android.intent.category.HOME >/dev/null 2>&1 || true

step "完成"
