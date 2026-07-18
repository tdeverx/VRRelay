#!/bin/zsh
# SPDX-License-Identifier: GPL-3.0-or-later
set -euo pipefail
USER_ID="$(/usr/bin/id -u)"
TARGET_ROOT="$HOME/Library/Application Support/VRRelay"
/bin/launchctl bootout "gui/$USER_ID/org.vrrelay.service" 2>/dev/null || true
/bin/rm -f "$HOME/Library/LaunchAgents/org.vrrelay.service.plist"
/bin/rm -rf "$TARGET_ROOT/runtime"
echo "VRRelay's user service was removed. Delete VRRelay.app separately. Data, cache, and logs were retained. Pass --purge-data to remove them."
if [[ "${1:-}" == "--purge-data" ]]; then
  /bin/rm -rf "$TARGET_ROOT" "$HOME/Library/Caches/VRRelay" "$HOME/Library/Logs/VRRelay"
fi
