#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-3.0-or-later
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DESTINATION="${1:-${RUNNER_TEMP:-$ROOT/.data/runtime}/vrrelay-ffmpeg}"

if [[ "$(uname -s)" != 'Linux' ]]; then
  echo 'The pinned Linux FFmpeg installer requires a Linux host.' >&2
  exit 1
fi

case "$DESTINATION" in
  '' | /)
    echo 'Refusing to install FFmpeg into an unsafe destination.' >&2
    exit 1
    ;;
esac

case "$(uname -m)" in
  x86_64)
    ARCHIVE='ffmpeg-n8.1.2-34-g9b6c8969e0-linux64-gpl-8.1.tar.xz'
    ;;
  aarch64 | arm64)
    ARCHIVE='ffmpeg-n8.1.2-34-g9b6c8969e0-linuxarm64-gpl-8.1.tar.xz'
    ;;
  *)
    echo "Unsupported FFmpeg architecture: $(uname -m)" >&2
    exit 1
    ;;
esac

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
URL="https://github.com/BtbN/FFmpeg-Builds/releases/download/autobuild-2026-07-31-14-10/$ARCHIVE"

curl --fail --location --retry 3 "$URL" --output "$WORK/$ARCHIVE"
node "$ROOT/script/verify-runtime.mjs" "$WORK/$ARCHIVE" >&2
mkdir -p "$DESTINATION"
tar -xJf "$WORK/$ARCHIVE" -C "$DESTINATION" --strip-components=1

FFMPEG="$DESTINATION/bin/ffmpeg"
VERSION_OUTPUT="$($FFMPEG -nostdin -hide_banner -version 2>&1)"
ENCODER_OUTPUT="$($FFMPEG -nostdin -hide_banner -encoders 2>&1)"
FILTER_OUTPUT="$($FFMPEG -nostdin -hide_banner -filters 2>&1)"

[[ "$VERSION_OUTPUT" == *'ffmpeg version n8.1.2-34-g9b6c8969e0'* ]]
[[ "$ENCODER_OUTPUT" == *'libx264'* ]]
[[ "$FILTER_OUTPUT" == *'subtitles'* ]]

printf '%s\n' "$DESTINATION/bin"
