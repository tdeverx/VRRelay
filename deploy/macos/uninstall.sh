#!/bin/zsh
# SPDX-License-Identifier: GPL-3.0-or-later
set -euo pipefail
[[ "${EUID}" -eq 0 ]] || { echo "Run with sudo" >&2; exit 1; }
launchctl bootout system/org.vrrelay.service 2>/dev/null || true
rm -f /Library/LaunchDaemons/org.vrrelay.service.plist
rm -rf /Applications/VRRelay.app "/Library/Application Support/VRRelay/runtime"
echo "VRRelay binaries removed. Data, cache, and logs were retained. Pass --purge-data to remove them."
if [[ "${1:-}" == "--purge-data" ]]; then rm -rf "/Library/Application Support/VRRelay" "/Library/Caches/VRRelay" "/Library/Logs/VRRelay"; fi
