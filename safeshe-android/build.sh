#!/usr/bin/env bash
# Builds SafeShe.apk without Gradle, using Ubuntu's Android SDK packages:
#   apt-get install aapt dalvik-exchange zipalign apksigner android-sdk-platform-23
# Signing key: $SAFESHE_KEYSTORE (default ../work/keys/safeshe-release.jks, git-ignored).
# Its password is read from the file $SAFESHE_KEYSTORE.pass and is never printed.
set -euo pipefail
cd "$(dirname "$0")"
export JAVA_TOOL_OPTIONS=""   # keep JVM banner noise out of tool output
SDK=/usr/lib/android-sdk
AJ=$SDK/platforms/android-23/android.jar
BT=$SDK/build-tools/debian
KS=${SAFESHE_KEYSTORE:-../work/keys/safeshe-release.jks}
OUT=${SAFESHE_OUT:-../outputs}
B=build
VER=$(grep -o 'versionName="[^"]*"' AndroidManifest.xml | cut -d\" -f2)

rm -rf "$B"; mkdir -p "$B/gen" "$B/classes" "$OUT"

echo "== aapt: resources + manifest"
# Server address baked into the app (users can still enter one on first launch if empty).
mkdir -p "$B/assets"; cp -R assets/. "$B/assets/"
printf 'window.SAFESHE_API = %s;\n' "$(python3 -c 'import json,os,sys; print(json.dumps(os.environ.get("SAFESHE_SERVER_URL","").rstrip("/")))')" > "$B/assets/config.js"
echo "   server URL: ${SAFESHE_SERVER_URL:-(none, asked on first launch)}"
aapt package -f -m -M AndroidManifest.xml -S res -A "$B/assets" -I "$AJ" -J "$B/gen" -F "$B/unsigned.apk"

echo "== javac"
javac -nowarn -Xlint:-options -source 8 -target 8 -bootclasspath "$AJ" -classpath "$AJ" \
  -d "$B/classes" $(find src "$B/gen" -name '*.java')

echo "== dx"
"$BT/dx" --dex --min-sdk-version=23 --output="$B/classes.dex" "$B/classes"
(cd "$B" && aapt add -v unsigned.apk classes.dex >/dev/null)

echo "== zipalign"
zipalign -f -p 4 "$B/unsigned.apk" "$B/aligned.apk"

if [ ! -f "$KS" ]; then
  echo "== generating new local signing key at $KS"
  mkdir -p "$(dirname "$KS")"; chmod 700 "$(dirname "$KS")"
  umask 077
  head -c 24 /dev/urandom | base64 | tr -d '/+=' > "$KS.pass"
  keytool -genkeypair -keystore "$KS" -storetype PKCS12 -alias safeshe -keyalg RSA -keysize 3072 \
    -validity 10000 -dname "CN=SafeShe, O=SafeShe" \
    -storepass:file "$KS.pass" -keypass:file "$KS.pass" >/dev/null 2>&1
fi

echo "== apksigner sign"
apksigner sign --ks "$KS" --ks-key-alias safeshe --ks-pass "file:$KS.pass" \
  --v1-signing-enabled true --v2-signing-enabled true --v3-signing-enabled true \
  --out "$OUT/SafeShe-$VER.apk" "$B/aligned.apk"
rm -f "$OUT/SafeShe-$VER.apk.idsig"
echo "== done: $OUT/SafeShe-$VER.apk"
