#!/bin/zsh
# SPDX-License-Identifier: GPL-3.0-or-later
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

cd "$root"
swift test --package-path apps/macos
swift build --package-path apps/macos -c release --arch arm64
deploy/macos/build-ffmpeg.sh "$work/ffmpeg"
mkdir -p "$work/ffmpeg/lib"
deploy/macos/bundle-dylibs.sh "$work/ffmpeg/ffmpeg" "$work/ffmpeg/lib"
"$work/ffmpeg/ffmpeg" -hide_banner -encoders >"$work/ffmpeg-encoders.txt"
"$work/ffmpeg/ffmpeg" -hide_banner -filters >"$work/ffmpeg-filters.txt"
grep -q h264_videotoolbox "$work/ffmpeg-encoders.txt"
grep -q libx264 "$work/ffmpeg-encoders.txt"
grep -q subtitles "$work/ffmpeg-filters.txt"
test -s "$work/ffmpeg/ffmpeg-build-metadata.json"
test -s "$work/ffmpeg/vrrelay-ffmpeg-8.1.2-darwin-arm64-source.tar.xz"
node script/runtime-provenance.mjs --output "$work/provenance.json" "ffmpeg=$work/ffmpeg/ffmpeg"
npm run verify:core
VRRELAY_BUILD_NUMBER="${VRRELAY_BUILD_NUMBER:-100}" \
  VRRELAY_FFMPEG_BINARY="$work/ffmpeg/ffmpeg" \
  deploy/macos/package.sh release dmg
