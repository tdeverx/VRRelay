#!/bin/zsh
# SPDX-License-Identifier: GPL-3.0-or-later
set -euo pipefail

[[ "$(uname -s)" == Darwin ]] || { echo 'macOS package verification requires macOS' >&2; exit 2; }
[[ "$#" -ge 2 && "$#" -le 3 ]] || {
  echo 'Usage: verify-macos-package.sh <package.pkg> <version> [build-number]' >&2
  exit 2
}

PACKAGE="${1:A}"
EXPECTED_VERSION="$2"
EXPECTED_BUILD="${3:-1}"
[[ -f "$PACKAGE" ]] || { echo "Package not found: $PACKAGE" >&2; exit 1; }

EXPANDED="$(mktemp -d /tmp/vrrelay-package.XXXXXX)"
rmdir "$EXPANDED"
cleanup() { rm -rf "$EXPANDED"; }
trap cleanup EXIT INT TERM
pkgutil --expand-full "$PACKAGE" "$EXPANDED"

PAYLOAD="$EXPANDED/Payload"
PACKAGE_INFO="$EXPANDED/PackageInfo"
APP="$PAYLOAD/Applications/VRRelay.app"
RUNTIME="$PAYLOAD/Library/Application Support/VRRelay/runtime"
SERVICE="$PAYLOAD/Library/LaunchDaemons/org.vrrelay.service.plist"

require_equal() {
  [[ "$1" == "$2" ]] || { echo "$3 is '$1', expected '$2'" >&2; exit 1; }
}

require_equal "$(xmllint --xpath 'string(/pkg-info/@identifier)' "$PACKAGE_INFO")" 'org.vrrelay.pkg' 'Package identifier'
require_equal "$(xmllint --xpath 'string(/pkg-info/@version)' "$PACKAGE_INFO")" "$EXPECTED_VERSION" 'Package version'
require_equal "$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$APP/Contents/Info.plist")" 'org.vrrelay.app' 'Application identifier'
require_equal "$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$APP/Contents/Info.plist")" "$EXPECTED_VERSION" 'Application version'
require_equal "$(/usr/libexec/PlistBuddy -c 'Print :CFBundleVersion' "$APP/Contents/Info.plist")" "$EXPECTED_BUILD" 'Application build'
require_equal "$(/usr/libexec/PlistBuddy -c 'Print :Label' "$SERVICE")" 'org.vrrelay.service' 'LaunchDaemon label'
require_equal "$(/usr/libexec/PlistBuddy -c 'Print :EnvironmentVariables:VRRELAY_VERSION' "$SERVICE")" "$EXPECTED_VERSION" 'LaunchDaemon version'
require_equal "$(/usr/libexec/PlistBuddy -c 'Print :ProgramArguments:0' "$SERVICE")" '/Library/Application Support/VRRelay/runtime/bin/node' 'LaunchDaemon executable'

[[ -x "$EXPANDED/Scripts/preinstall" && -x "$EXPANDED/Scripts/postinstall" ]] || {
  echo 'Installer lifecycle scripts are missing or not executable' >&2
  exit 1
}

codesign --verify --deep --strict "$APP"
require_equal "$(lipo -archs "$APP/Contents/MacOS/VRRelayMac")" arm64 'Application architecture'

typeset -a MACH_O_FILES
MACH_O_FILES=("$RUNTIME/bin/node" "$RUNTIME/bin/ffmpeg" "$RUNTIME/bin/mediamtx" "$RUNTIME"/lib/*.dylib(N))
for binary in "${MACH_O_FILES[@]}"; do
  codesign --verify --strict "$binary"
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

require_equal "$("$RUNTIME/bin/node" --version)" v22.23.1 'Node version'
"$RUNTIME/bin/mediamtx" --version > "$EXPANDED/mediamtx-version.txt"
"$RUNTIME/bin/ffmpeg" -nostdin -hide_banner -version > "$EXPANDED/ffmpeg-version.txt"
"$RUNTIME/bin/ffmpeg" -nostdin -hide_banner -encoders > "$EXPANDED/ffmpeg-encoders.txt" 2>/dev/null
"$RUNTIME/bin/ffmpeg" -nostdin -hide_banner -filters > "$EXPANDED/ffmpeg-filters.txt" 2>/dev/null
grep -Fq 'v1.18.2' "$EXPANDED/mediamtx-version.txt"
grep -Fq 'ffmpeg version 7.1.5' "$EXPANDED/ffmpeg-version.txt"
grep -Fq libx264 "$EXPANDED/ffmpeg-encoders.txt"
grep -Fq h264_videotoolbox "$EXPANDED/ffmpeg-encoders.txt"
grep -Fq subtitles "$EXPANDED/ffmpeg-filters.txt"

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

if ! pkgutil --check-signature "$PACKAGE" >/dev/null 2>&1; then
  [[ "${VRRELAY_REQUIRE_PACKAGE_SIGNATURE:-0}" != 1 ]] || {
    echo 'Installer package is not signed' >&2
    exit 1
  }
fi

echo "macOS package verification passed for VRRelay $EXPECTED_VERSION ($EXPECTED_BUILD)."
