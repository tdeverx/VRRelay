#!/bin/zsh
# SPDX-License-Identifier: GPL-3.0-or-later
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
./deploy/macos/package.sh debug app
pkill -x VRRelayMac 2>/dev/null || true
open dist/VRRelay.app
