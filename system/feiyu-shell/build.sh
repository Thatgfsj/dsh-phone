#!/usr/bin/env bash
# 构建肥鱼空白桌面 APK（纯 SDK 命令行：aapt2 + javac + d8 + zipalign + apksigner）。
#
# 依赖：JDK 17（javac/keytool）、Android SDK（build-tools/34.0.0、platforms/android-34）。
# 产物：system/feiyu-shell/feiyu-shell.apk（入库，便于 provisioning 直接用）。
# debug keystore 生成在 build/debug.keystore，不入库（可复用本地文件）。
set -euo pipefail

HERE="${BASH_SOURCE[0]}"; HERE="$(cd "$(dirname "$HERE")" && pwd)"
SDK="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-$HOME/Android/Sdk}}"
BUILD_TOOLS="${BUILD_TOOLS:-$SDK/build-tools/34.0.0}"
PLATFORM="${ANDROID_PLATFORM:-$SDK/platforms/android-34/android.jar}"
OUT="$HERE/build"
APK="$HERE/feiyu-shell.apk"

for tool in "$BUILD_TOOLS/aapt2" "$BUILD_TOOLS/d8" "$BUILD_TOOLS/zipalign" "$BUILD_TOOLS/apksigner" "$PLATFORM"; do
  [ -e "$tool" ] || { echo "[build] 缺少: $tool" >&2; exit 1; }
done
KEYTOOL="${KEYTOOL:-$(command -v keytool || echo "$JAVA_HOME/bin/keytool")}"
[ -x "$KEYTOOL" ] || { echo "[build] 找不到 keytool（需要 JDK）" >&2; exit 1; }

rm -rf "$OUT"
mkdir -p "$OUT/classes" "$OUT/gen" "$OUT/dex"

echo "[build] aapt2 link（manifest + assets）"
"$BUILD_TOOLS/aapt2" link \
  --manifest "$HERE/AndroidManifest.xml" \
  -I "$PLATFORM" \
  -A "$HERE/assets" \
  --java "$OUT/gen" \
  -o "$OUT/base.apk"

echo "[build] javac"
find "$HERE/src" -name '*.java' > "$OUT/sources.txt"
if [ -n "$(find "$OUT/gen" -name '*.java' -print -quit)" ]; then
  find "$OUT/gen" -name '*.java' >> "$OUT/sources.txt"
fi
javac -source 11 -target 11 -encoding UTF-8 -Xlint:-options \
  -classpath "$PLATFORM" \
  -d "$OUT/classes" @"$OUT/sources.txt"

echo "[build] d8（dex）"
find "$OUT/classes" -name '*.class' > "$OUT/classes.txt"
"$BUILD_TOOLS/d8" --lib "$PLATFORM" --min-api 30 --output "$OUT/dex" @"$OUT/classes.txt"

echo "[build] 打包 classes.dex 进 APK"
python3 - "$OUT/base.apk" "$OUT/dex/classes.dex" <<'PY'
import sys, zipfile
apk, dex = sys.argv[1], sys.argv[2]
with zipfile.ZipFile(apk, 'a', compression=zipfile.ZIP_DEFLATED) as zf:
    zf.write(dex, 'classes.dex')
PY

echo "[build] zipalign + apksigner"
"$BUILD_TOOLS/zipalign" -f -p 4 "$OUT/base.apk" "$OUT/aligned.apk"
KEYSTORE="$OUT/debug.keystore"
if [ ! -f "$KEYSTORE" ]; then
  "$KEYTOOL" -genkeypair -keystore "$KEYSTORE" -storepass android -keypass android \
    -alias androiddebugkey -keyalg RSA -keysize 2048 -validity 10000 \
    -dname "CN=Android Debug,O=Android,C=US" >/dev/null 2>&1
fi
"$BUILD_TOOLS/apksigner" sign \
  --ks "$KEYSTORE" --ks-pass pass:android --key-pass pass:android \
  --out "$APK" "$OUT/aligned.apk"
"$BUILD_TOOLS/apksigner" verify "$APK" >/dev/null
echo "[build] 完成: $APK"
