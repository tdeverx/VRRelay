#!/bin/zsh
# SPDX-License-Identifier: GPL-3.0-or-later
set -euo pipefail
export COPYFILE_DISABLE=1
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
CONFIGURATION="${1:-release}"
FORMAT="${2:-dmg}"
PACKAGE_VERSION="${VRRELAY_VERSION:-$(node -p "require('$ROOT/package.json').version")}"
VERSION="$(node "$ROOT/script/release-version.mjs" "$PACKAGE_VERSION")"
BUILD_NUMBER="${VRRELAY_BUILD_NUMBER:-${GITHUB_RUN_NUMBER:-1}}"
[[ "$BUILD_NUMBER" =~ ^[1-9][0-9]*$ ]] || { echo "VRRELAY_BUILD_NUMBER must be a positive integer" >&2; exit 1; }
RELEASE_PACKAGING="${VRRELAY_RELEASE_PACKAGING:-0}"
if [[ "$RELEASE_PACKAGING" == "1" ]]; then
  [[ -n "${APPLE_DEVELOPER_ID:-}" ]] || { echo "APPLE_DEVELOPER_ID is required for release packaging" >&2; exit 1; }
  [[ -n "${APPLE_NOTARY_PROFILE:-}" ]] || { echo "APPLE_NOTARY_PROFILE is required for release packaging" >&2; exit 1; }
  [[ -z "${VRRELAY_FFMPEG_BINARY:-}" ]] || { echo "VRRELAY_FFMPEG_BINARY is not accepted for release packaging; FFmpeg must be built from the pinned source recipe" >&2; exit 1; }
fi
BUILD_ROOT="$ROOT/dist/macos"
APP="$BUILD_ROOT/VRRelay.app"
IMAGE_ROOT="$BUILD_ROOT/image"
OUTPUT="$ROOT/dist/VRRelay-$VERSION-macOS-arm64.dmg"
FFMPEG_SOURCE_OUTPUT="$ROOT/dist/VRRelay-$VERSION-macOS-FFmpeg-source.tar.xz"
rm -rf "$BUILD_ROOT" "$OUTPUT" "$FFMPEG_SOURCE_OUTPUT"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
npm --prefix "$ROOT" run build
swift build --package-path "$ROOT/apps/macos" -c "$CONFIGURATION" --arch arm64
cp "$ROOT/apps/macos/.build/$CONFIGURATION/VRRelayMac" "$APP/Contents/MacOS/VRRelayMac"
cp "$ROOT/deploy/macos/Info.plist" "$APP/Contents/Info.plist"
/usr/libexec/PlistBuddy -c "Set :CFBundleShortVersionString $VERSION" "$APP/Contents/Info.plist"
/usr/libexec/PlistBuddy -c "Set :CFBundleVersion $BUILD_NUMBER" "$APP/Contents/Info.plist"
RUNTIME="$APP/Contents/Resources/runtime"
mkdir -p "$RUNTIME/apps/relay" "$RUNTIME/apps/web" "$RUNTIME/packages" "$RUNTIME/bin" "$RUNTIME/licenses"
cp -R "$ROOT/apps/relay/dist" "$ROOT/apps/relay/public" "$RUNTIME/apps/relay/"
cp "$ROOT/apps/relay/package.json" "$RUNTIME/apps/relay/"
cp -R "$ROOT/packages/"* "$RUNTIME/packages/"
cp "$ROOT/package.json" "$ROOT/package-lock.json" "$RUNTIME/"
cp "$ROOT/LICENSE" "$ROOT/THIRD_PARTY_NOTICES.md" "$RUNTIME/"
cp "$ROOT/deploy/runtime-manifest.json" "$RUNTIME/"
cp "$ROOT/deploy/native/mediamtx.yml" "$RUNTIME/"
DOWNLOADS="$ROOT/dist/macos/downloads"
mkdir -p "$DOWNLOADS"
NODE_ARCHIVE="$DOWNLOADS/node-v26.5.0-darwin-arm64.tar.gz"
MEDIAMTX_ARCHIVE="$DOWNLOADS/mediamtx_v1.19.2_darwin_arm64.tar.gz"
FFMPEG_SOURCE="$DOWNLOADS/ffmpeg-8.1.2.tar.xz"
[[ -f "$NODE_ARCHIVE" ]] || curl -fL "https://nodejs.org/download/release/v26.5.0/$(basename "$NODE_ARCHIVE")" -o "$NODE_ARCHIVE"
[[ -f "$MEDIAMTX_ARCHIVE" ]] || curl -fL "https://github.com/bluenviron/mediamtx/releases/download/v1.19.2/$(basename "$MEDIAMTX_ARCHIVE")" -o "$MEDIAMTX_ARCHIVE"
node "$ROOT/script/verify-runtime.mjs" "$NODE_ARCHIVE" "$MEDIAMTX_ARCHIVE"
tar -xzf "$NODE_ARCHIVE" -C "$DOWNLOADS"
tar -xzf "$MEDIAMTX_ARCHIVE" -C "$DOWNLOADS"
cp "$DOWNLOADS/node-v26.5.0-darwin-arm64/bin/node" "$RUNTIME/bin/node"
cp "$DOWNLOADS/mediamtx" "$RUNTIME/bin/mediamtx"
if [[ -n "${VRRELAY_FFMPEG_BINARY:-}" ]]; then
  [[ -x "$VRRELAY_FFMPEG_BINARY" ]] || { echo "VRRELAY_FFMPEG_BINARY must point to an executable FFmpeg 8.1.2 development binary" >&2; exit 1; }
  [[ -f "$FFMPEG_SOURCE" ]] || curl -fL "https://ffmpeg.org/releases/$(basename "$FFMPEG_SOURCE")" -o "$FFMPEG_SOURCE"
  node "$ROOT/script/verify-runtime.mjs" "$FFMPEG_SOURCE"
  tar -xOf "$FFMPEG_SOURCE" ffmpeg-8.1.2/COPYING.GPLv3 > "$RUNTIME/licenses/FFmpeg-GPLv3.txt"
  cp "$VRRELAY_FFMPEG_BINARY" "$RUNTIME/bin/ffmpeg"
else
  FFMPEG_BUILD="$DOWNLOADS/ffmpeg-build"
  "$ROOT/deploy/macos/build-ffmpeg.sh" "$FFMPEG_BUILD"
  cp "$FFMPEG_BUILD/ffmpeg" "$RUNTIME/bin/ffmpeg"
  cp "$FFMPEG_BUILD/licenses/"* "$RUNTIME/licenses/"
  cp "$FFMPEG_BUILD/ffmpeg-build-metadata.json" "$RUNTIME/"
  cp "$FFMPEG_BUILD/vrrelay-ffmpeg-8.1.2-darwin-arm64-source.tar.xz" "$FFMPEG_SOURCE_OUTPUT"
fi
"$ROOT/deploy/macos/bundle-dylibs.sh" "$RUNTIME/bin/ffmpeg" "$RUNTIME/lib"
(cd "$RUNTIME" && export PATH="$DOWNLOADS/node-v26.5.0-darwin-arm64/bin:$PATH" && npm install --global npm@12.0.1 && npm ci --omit=dev --legacy-peer-deps)
rm -rf "$DOWNLOADS/node-v26.5.0-darwin-arm64" "$DOWNLOADS/mediamtx" "$NODE_ARCHIVE" "$MEDIAMTX_ARCHIVE" "$FFMPEG_SOURCE"
cp "$ROOT/deploy/macos/org.vrrelay.service.plist" "$APP/Contents/Resources/"
cp "$ROOT/deploy/macos/install-service.sh" "$APP/Contents/Resources/"
/usr/libexec/PlistBuddy -c "Add :EnvironmentVariables:VRRELAY_VERSION string $VERSION" "$APP/Contents/Resources/org.vrrelay.service.plist"
chmod 0644 "$APP/Contents/Resources/org.vrrelay.service.plist"
chmod 0755 "$APP/Contents/Resources/install-service.sh"
chmod 0755 "$RUNTIME/bin/node" "$RUNTIME/bin/ffmpeg" "$RUNTIME/bin/mediamtx"
find "$APP" -name '._*' -delete
xattr -cr "$APP"
for binary in "$RUNTIME/bin/node" "$RUNTIME/bin/ffmpeg" "$RUNTIME/bin/mediamtx" "$RUNTIME/lib"/*(.N); do
  if [[ -n "${APPLE_DEVELOPER_ID:-}" ]]; then
    codesign --force --options runtime --timestamp --sign "$APPLE_DEVELOPER_ID" "$binary"
  else
    codesign --force --sign - "$binary"
  fi
done
"$RUNTIME/bin/ffmpeg" -hide_banner -version | sed -n '1p'
node "$ROOT/script/runtime-provenance.mjs" --output "$RUNTIME/runtime-provenance.json" "node=$RUNTIME/bin/node" "ffmpeg=$RUNTIME/bin/ffmpeg" "mediamtx=$RUNTIME/bin/mediamtx"
if [[ -n "${APPLE_DEVELOPER_ID:-}" ]]; then
  codesign --force --options runtime --timestamp --entitlements "$ROOT/deploy/macos/entitlements.plist" --sign "$APPLE_DEVELOPER_ID" "$APP"
else
  codesign --force --deep --sign - "$APP"
fi
codesign --verify --deep --strict --verbose=2 "$APP"
plutil -lint "$APP/Contents/Info.plist" "$APP/Contents/Resources/org.vrrelay.service.plist"
[[ "$FORMAT" == "app" ]] && { ditto "$APP" "$ROOT/dist/VRRelay.app"; rm -rf "$BUILD_ROOT"; exit 0; }
[[ "$FORMAT" == "dmg" ]] || { echo "Unsupported macOS package format: $FORMAT" >&2; exit 2; }
mkdir -p "$IMAGE_ROOT"
ditto "$APP" "$IMAGE_ROOT/VRRelay.app"
ln -s /Applications "$IMAGE_ROOT/Applications"
hdiutil create -volname VRRelay -srcfolder "$IMAGE_ROOT" -ov -format UDZO "$OUTPUT"
if [[ "$RELEASE_PACKAGING" == "1" ]]; then export VRRELAY_REQUIRE_DEVELOPER_ID=1; fi
"$ROOT/script/verify-macos-dmg.sh" "$OUTPUT" "$VERSION" "$BUILD_NUMBER"
if [[ -n "${APPLE_NOTARY_PROFILE:-}" ]]; then
  xcrun notarytool submit "$OUTPUT" --keychain-profile "$APPLE_NOTARY_PROFILE" --wait
  xcrun stapler staple "$OUTPUT"
  xcrun stapler validate "$OUTPUT"
  export VRRELAY_REQUIRE_NOTARIZATION=1
  "$ROOT/script/verify-macos-dmg.sh" "$OUTPUT" "$VERSION" "$BUILD_NUMBER"
fi
rm -rf "$BUILD_ROOT"
echo "$OUTPUT"
