#!/bin/zsh
# SPDX-License-Identifier: GPL-3.0-or-later
set -euo pipefail

[[ "${EUID}" -eq 0 ]] || { echo "Service changes require administrator privileges" >&2; exit 1; }
[[ "$#" -eq 1 ]] || { echo "Usage: install-service.sh <start|restart|stop>" >&2; exit 2; }

ACTION="$1"
LABEL="system/org.vrrelay.service"
TARGET_ROOT="/Library/Application Support/VRRelay"
TARGET_RUNTIME="$TARGET_ROOT/runtime"
TARGET_PLIST="/Library/LaunchDaemons/org.vrrelay.service.plist"
RESOURCE_ROOT="${0:A:h}"

if [[ "$ACTION" == "stop" ]]; then
  /bin/launchctl bootout "$LABEL" 2>/dev/null || true
  exit 0
fi
[[ "$ACTION" == "start" || "$ACTION" == "restart" ]] || { echo "Unknown service action: $ACTION" >&2; exit 2; }
[[ -x "$RESOURCE_ROOT/runtime/bin/node" && -f "$RESOURCE_ROOT/org.vrrelay.service.plist" ]] || {
  echo "VRRelay.app does not contain a complete service runtime" >&2
  exit 1
}

install -d -m 0750 "$TARGET_ROOT" "/Library/Caches/VRRelay" "/Library/Logs/VRRelay"
install -d -m 0700 "$TARGET_ROOT/data"
/bin/launchctl bootout "$LABEL" 2>/dev/null || true

NEXT_RUNTIME="$TARGET_ROOT/runtime.next"
PREVIOUS_RUNTIME="$TARGET_ROOT/runtime.previous"
rm -rf "$NEXT_RUNTIME" "$PREVIOUS_RUNTIME"
/usr/bin/ditto "$RESOURCE_ROOT/runtime" "$NEXT_RUNTIME"
chown -R root:wheel "$NEXT_RUNTIME" "$TARGET_ROOT/data" "/Library/Caches/VRRelay" "/Library/Logs/VRRelay"
if [[ -d "$TARGET_RUNTIME" ]]; then mv "$TARGET_RUNTIME" "$PREVIOUS_RUNTIME"; fi
if ! mv "$NEXT_RUNTIME" "$TARGET_RUNTIME"; then
  [[ ! -d "$PREVIOUS_RUNTIME" ]] || mv "$PREVIOUS_RUNTIME" "$TARGET_RUNTIME"
  exit 1
fi
rm -rf "$PREVIOUS_RUNTIME"
install -o root -g wheel -m 0644 "$RESOURCE_ROOT/org.vrrelay.service.plist" "$TARGET_PLIST"
/bin/launchctl bootstrap system "$TARGET_PLIST"
/bin/launchctl enable "$LABEL"
/bin/launchctl kickstart -k "$LABEL"
