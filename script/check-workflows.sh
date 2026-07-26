#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-3.0-or-later
set -euo pipefail

VERSION="1.7.12"
OS="$(uname -s | tr '[:upper:]' '[:lower:]')"
ARCH="$(uname -m)"
case "$OS/$ARCH" in
  linux/x86_64) PLATFORM="linux_amd64"; SHA256="8aca8db96f1b94770f1b0d72b6dddcb1ebb8123cb3712530b08cc387b349a3d8" ;;
  linux/aarch64|linux/arm64) PLATFORM="linux_arm64"; SHA256="325e971b6ba9bfa504672e29be93c24981eeb1c07576d730e9f7c8805afff0c6" ;;
  darwin/x86_64) PLATFORM="darwin_amd64"; SHA256="5b44c3bc2255115c9b69e30efc0fecdf498fdb63c5d58e17084fd5f16324c644" ;;
  darwin/arm64) PLATFORM="darwin_arm64"; SHA256="aba9ced2dee8d27fecca3dc7feb1a7f9a52caefa1eb46f3271ea66b6e0e6953f" ;;
  *) echo "Unsupported actionlint platform: $OS/$ARCH" >&2; exit 1 ;;
esac

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
ARCHIVE="actionlint_${VERSION}_${PLATFORM}.tar.gz"
curl -fsSL "https://github.com/rhysd/actionlint/releases/download/v${VERSION}/${ARCHIVE}" -o "$WORK/$ARCHIVE"
echo "$SHA256  $WORK/$ARCHIVE" | shasum -a 256 --check --strict
tar -xzf "$WORK/$ARCHIVE" -C "$WORK" actionlint
# GitHub's queue key is newer than actionlint 1.7.12. Ignore only that parser
# diagnostic while retaining every other workflow syntax and semantic check.
"$WORK/actionlint" \
  -ignore 'unexpected key "queue" for "concurrency" section' \
  .github/workflows/*.yml
