#!/bin/zsh
# SPDX-License-Identifier: GPL-3.0-or-later
set -euo pipefail

[[ "$(uname -s)" == Darwin ]] || { echo 'macOS DMG verification requires macOS' >&2; exit 2; }
[[ "$#" -ge 2 && "$#" -le 3 ]] || {
  echo 'Usage: verify-macos-dmg.sh <image.dmg> <version> [build-number]' >&2
  exit 2
}

IMAGE="${1:A}"
EXPECTED_VERSION="$2"
EXPECTED_BUILD="${3:-1}"
[[ -f "$IMAGE" ]] || { echo "DMG not found: $IMAGE" >&2; exit 1; }

MOUNT_POINT="$(mktemp -d /tmp/vrrelay-dmg.XXXXXX)"
WORK_DIR="$(mktemp -d /tmp/vrrelay-dmg-verify.XXXXXX)"
cleanup() {
  hdiutil detach "$MOUNT_POINT" -quiet 2>/dev/null || true
  rmdir "$MOUNT_POINT" 2>/dev/null || true
  rm -rf "$WORK_DIR"
}
trap cleanup EXIT INT TERM
hdiutil attach -readonly -nobrowse -mountpoint "$MOUNT_POINT" "$IMAGE" >/dev/null

APP="$MOUNT_POINT/VRRelay.app"
RUNTIME="$APP/Contents/Resources/runtime"
SERVICE="$APP/Contents/Resources/org.vrrelay.service.plist"
INSTALLER="$APP/Contents/Resources/install-service.sh"

require_equal() {
  [[ "$1" == "$2" ]] || { echo "$3 is '$1', expected '$2'" >&2; exit 1; }
}

[[ -L "$MOUNT_POINT/Applications" && "$(readlink "$MOUNT_POINT/Applications")" == '/Applications' ]] || {
  echo 'DMG does not contain the Applications shortcut' >&2
  exit 1
}
require_equal "$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$APP/Contents/Info.plist")" 'org.vrrelay.app' 'Application identifier'
require_equal "$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$APP/Contents/Info.plist")" "$EXPECTED_VERSION" 'Application version'
require_equal "$(/usr/libexec/PlistBuddy -c 'Print :CFBundleVersion' "$APP/Contents/Info.plist")" "$EXPECTED_BUILD" 'Application build'
require_equal "$(/usr/libexec/PlistBuddy -c 'Print :Label' "$SERVICE")" 'org.vrrelay.service' 'LaunchAgent label'
require_equal "$(/usr/libexec/PlistBuddy -c 'Print :EnvironmentVariables:VRRELAY_VERSION' "$SERVICE")" "$EXPECTED_VERSION" 'LaunchAgent version'
require_equal "$(/usr/libexec/PlistBuddy -c 'Print :ProgramArguments:0' "$SERVICE")" 'VRRELAY_RUNTIME/bin/node' 'LaunchAgent executable template'
require_equal "$(<"$RUNTIME/build-id.txt")" "$EXPECTED_VERSION-$EXPECTED_BUILD" 'Runtime build identifier'
[[ -x "$INSTALLER" ]] || { echo 'User service installer is missing or not executable' >&2; exit 1; }
grep -Fq 'runtime.next' "$INSTALLER"
grep -Fq 'launchctl bootstrap "$SERVICE_DOMAIN"' "$INSTALLER"
if grep -Eq 'osascript|administrator privileges|/Library/LaunchDaemons|bootstrap system' "$INSTALLER"; then
  echo 'User service installer contains a legacy elevation or LaunchDaemon path' >&2
  exit 1
fi

codesign --verify --deep --strict "$APP"
require_equal "$(lipo -archs "$APP/Contents/MacOS/VRRelayMac")" arm64 'Application architecture'
APP_SIGNING_AUTHORITY=''
APP_SIGNING_TEAM=''
if [[ "${VRRELAY_REQUIRE_DEVELOPER_ID:-0}" == 1 ]]; then
  app_signing_details="$(codesign -dv --verbose=4 "$APP" 2>&1)"
  APP_SIGNING_AUTHORITY="$(
    print -r -- "$app_signing_details" |
      awk '/^Authority=/ && !found { sub(/^Authority=/, ""); print; found=1 }'
  )"
  APP_SIGNING_TEAM="$(
    print -r -- "$app_signing_details" |
      awk '/^TeamIdentifier=/ { sub(/^TeamIdentifier=/, ""); print }'
  )"
  [[ "$APP_SIGNING_AUTHORITY" == 'Developer ID Application:'* ]] || {
    echo 'Application is not signed with a Developer ID Application identity' >&2
    exit 1
  }
  [[ -n "$APP_SIGNING_TEAM" && "$APP_SIGNING_TEAM" != 'not set' ]] || {
    echo 'Application signature does not declare a Developer ID team' >&2
    exit 1
  }
  [[ "$APP_SIGNING_AUTHORITY" == *"($APP_SIGNING_TEAM)" ]] || {
    echo 'Application signing authority does not match its TeamIdentifier' >&2
    exit 1
  }
fi

typeset -a SIGNED_MACH_O_FILES RUNTIME_RELOCATABLE_FILES
while IFS= read -r -d '' candidate; do
  file_description="$(/usr/bin/file -b "$candidate")"
  if [[ "$file_description" == *Mach-O* ]]; then
    SIGNED_MACH_O_FILES+=("$candidate")
  elif [[ "$candidate" == *.node ]]; then
    echo "Native Node add-on is not a Mach-O binary: $candidate" >&2
    exit 1
  fi
done < <(find "$APP/Contents" -depth -type f -print0)
(( ${#SIGNED_MACH_O_FILES[@]} > 0 )) || {
  echo 'Application bundle contains no nested Mach-O binaries' >&2
  exit 1
}

for binary in "${SIGNED_MACH_O_FILES[@]}"; do
  relative_binary="${binary#$APP/}"
  codesign --verify --strict --verbose=2 "$binary"
  binary_architectures="$(lipo -archs "$binary")"
  [[ " $binary_architectures " == *' arm64 '* ]] || {
    echo "Nested code does not contain arm64: $relative_binary" >&2
    exit 1
  }
  if [[ "${VRRELAY_REQUIRE_DEVELOPER_ID:-0}" == 1 ]]; then
    binary_signing_details="$(codesign -dv --verbose=4 "$binary" 2>&1)"
    binary_signing_authority="$(
      print -r -- "$binary_signing_details" |
        awk '/^Authority=/ && !found { sub(/^Authority=/, ""); print; found=1 }'
    )"
    binary_signing_team="$(
      print -r -- "$binary_signing_details" |
        awk '/^TeamIdentifier=/ { sub(/^TeamIdentifier=/, ""); print }'
    )"
    require_equal "$binary_signing_authority" "$APP_SIGNING_AUTHORITY" "Signing authority for $relative_binary"
    require_equal "$binary_signing_team" "$APP_SIGNING_TEAM" "Signing team for $relative_binary"
    print -r -- "$binary_signing_details" | grep -Fq '(runtime)' || {
      echo "Hardened runtime is not enabled for $relative_binary" >&2
      exit 1
    }
    print -r -- "$binary_signing_details" | grep -Eq '^Timestamp=.+$' || {
      echo "Secure timestamp is missing for $relative_binary" >&2
      exit 1
    }
  fi
done

if [[ "${VRRELAY_REQUIRE_DEVELOPER_ID:-0}" == 1 ]]; then
  NODE_ENTITLEMENTS="$WORK_DIR/node-entitlements.plist"
  codesign -d --entitlements :- "$RUNTIME/bin/node" > "$NODE_ENTITLEMENTS" 2>/dev/null
  require_equal "$(/usr/libexec/PlistBuddy -c 'Print :com.apple.security.cs.allow-jit' "$NODE_ENTITLEMENTS")" true 'Node allow-jit entitlement'
  require_equal "$(/usr/libexec/PlistBuddy -c 'Print :com.apple.security.cs.allow-unsigned-executable-memory' "$NODE_ENTITLEMENTS")" true 'Node allow-unsigned-executable-memory entitlement'
  if /usr/libexec/PlistBuddy -c 'Print :com.apple.security.cs.disable-library-validation' "$NODE_ENTITLEMENTS" 2>/dev/null | grep -Fxq true; then
    echo 'Packaged Node must retain hardened-runtime library validation' >&2
    exit 1
  fi
fi

RUNTIME_RELOCATABLE_FILES=("$RUNTIME/bin/node" "$RUNTIME/bin/ffmpeg" "$RUNTIME/bin/mediamtx" "$RUNTIME"/lib/*.dylib(N))
for binary in "${RUNTIME_RELOCATABLE_FILES[@]}"; do
  require_equal "$(lipo -archs "$binary")" arm64 "Architecture for $(basename "$binary")"
  loads="$(otool -L "$binary" | tail -n +2 | awk '{print $1}')"
  if print -r -- "$loads" | grep -Eq '^(/opt/homebrew|/usr/local|@rpath)'; then
    echo "Non-relocatable load command remains in $binary" >&2
    exit 1
  fi
  rpaths="$(otool -l "$binary" | awk '/cmd LC_RPATH/{getline; getline; print $2}')"
  if [[ -n "$rpaths" ]] && print -r -- "$rpaths" | grep -Ev '^(@loader_path|@executable_path)(/|$)|^/System/|^/usr/lib/' >/dev/null; then
    echo "Non-relocatable runtime search path remains in $binary" >&2
    exit 1
  fi
done

require_equal "$("$RUNTIME/bin/node" --version)" v26.5.0 'Node version'
(
  cd "$RUNTIME"
  "$RUNTIME/bin/node" <<'NODE'
const Database = require('better-sqlite3');
const { hash, verify } = require('@node-rs/argon2');

(async () => {
  const database = new Database(':memory:');
  const row = database.prepare('SELECT 1 AS value').get();
  database.close();
  if (row?.value !== 1) throw new Error('better-sqlite3 native query failed');

  const password = 'vrrelay-native-signing-smoke';
  const encoded = await hash(password, { memoryCost: 4096, timeCost: 1, parallelism: 1 });
  if (!(await verify(encoded, password))) throw new Error('@node-rs/argon2 native verification failed');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
NODE
)
"$RUNTIME/bin/mediamtx" --version > "$WORK_DIR/mediamtx-version.txt"
"$RUNTIME/bin/ffmpeg" -nostdin -hide_banner -version > "$WORK_DIR/ffmpeg-version.txt"
"$RUNTIME/bin/ffmpeg" -nostdin -hide_banner -encoders > "$WORK_DIR/ffmpeg-encoders.txt" 2>/dev/null
"$RUNTIME/bin/ffmpeg" -nostdin -hide_banner -filters > "$WORK_DIR/ffmpeg-filters.txt" 2>/dev/null
grep -Fq 'v1.19.2' "$WORK_DIR/mediamtx-version.txt"
grep -Fq 'ffmpeg version 8.1.2' "$WORK_DIR/ffmpeg-version.txt"
grep -Fq libx264 "$WORK_DIR/ffmpeg-encoders.txt"
grep -Fq h264_videotoolbox "$WORK_DIR/ffmpeg-encoders.txt"
grep -Fq subtitles "$WORK_DIR/ffmpeg-filters.txt"

"$RUNTIME/bin/node" --input-type=module - "$RUNTIME" <<'NODE'
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
const runtime = process.argv[2];
const provenance = JSON.parse(readFileSync(join(runtime, 'runtime-provenance.json'), 'utf8'));
for (const component of provenance.components) {
  const actual = createHash('sha256').update(readFileSync(join(runtime, 'bin', component.file))).digest('hex');
  if (actual !== component.sha256) throw new Error(`Provenance mismatch for ${component.name}`);
}
NODE

if [[ "${VRRELAY_REQUIRE_NOTARIZATION:-0}" == 1 ]]; then
  xcrun stapler validate "$IMAGE"
  spctl --assess --type open --context context:primary-signature --verbose=2 "$IMAGE"
  spctl --assess --type execute --verbose=2 "$APP"
fi

echo "macOS DMG verification passed for VRRelay $EXPECTED_VERSION ($EXPECTED_BUILD)."
