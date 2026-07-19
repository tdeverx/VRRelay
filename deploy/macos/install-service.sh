#!/bin/zsh
# SPDX-License-Identifier: GPL-3.0-or-later
set -euo pipefail
umask 077

[[ "$#" -eq 1 ]] || { echo "Usage: install-service.sh <start|restart|stop>" >&2; exit 2; }

ACTION="$1"
USER_ID="$(/usr/bin/id -u)"
SERVICE_DOMAIN="gui/$USER_ID"
SERVICE_TARGET="$SERVICE_DOMAIN/org.vrrelay.service"
TARGET_ROOT="$HOME/Library/Application Support/VRRelay"
TARGET_RUNTIME="$TARGET_ROOT/runtime"
TARGET_PLIST="$HOME/Library/LaunchAgents/org.vrrelay.service.plist"
TARGET_CACHE="$HOME/Library/Caches/VRRelay"
TARGET_LOGS="$HOME/Library/Logs/VRRelay"
RESOURCE_ROOT="${0:A:h}"

if [[ "$ACTION" == "stop" ]]; then
  /bin/launchctl bootout "$SERVICE_TARGET" 2>/dev/null || true
  exit 0
fi
[[ "$ACTION" == "start" || "$ACTION" == "restart" ]] || { echo "Unknown service action: $ACTION" >&2; exit 2; }
[[ -x "$RESOURCE_ROOT/runtime/bin/node" && -f "$RESOURCE_ROOT/runtime/build-id.txt" && -f "$RESOURCE_ROOT/org.vrrelay.service.plist" ]] || {
  echo "VRRelay.app does not contain a complete service runtime" >&2
  exit 1
}

/bin/mkdir -p "$TARGET_ROOT" "$TARGET_ROOT/data" "$TARGET_CACHE" "$TARGET_LOGS" "${TARGET_PLIST:h}"
/bin/chmod 0700 "$TARGET_ROOT" "$TARGET_ROOT/data" "$TARGET_CACHE" "$TARGET_LOGS"

NEXT_PLIST="$(/usr/bin/mktemp "$TARGET_ROOT/service-plist.XXXXXX")"
cleanup() { [[ -z "$NEXT_PLIST" ]] || /bin/rm -f "$NEXT_PLIST"; }
trap cleanup EXIT INT TERM
/usr/bin/ditto "$RESOURCE_ROOT/org.vrrelay.service.plist" "$NEXT_PLIST"
/usr/libexec/PlistBuddy -c "Set :ProgramArguments:0 $TARGET_RUNTIME/bin/node" "$NEXT_PLIST"
/usr/libexec/PlistBuddy -c "Set :ProgramArguments:1 $TARGET_RUNTIME/service-runner.mjs" "$NEXT_PLIST"
/usr/libexec/PlistBuddy -c "Set :ProgramArguments:2 $TARGET_RUNTIME/apps/relay/dist/main.js" "$NEXT_PLIST"
/usr/libexec/PlistBuddy -c "Set :ProgramArguments:3 $TARGET_LOGS/service.log" "$NEXT_PLIST"
/usr/bin/plutil -replace WorkingDirectory -string "$TARGET_RUNTIME" "$NEXT_PLIST"
/usr/bin/plutil -replace EnvironmentVariables.VRRELAY_DATA_DIR -string "$TARGET_ROOT/data" "$NEXT_PLIST"
/usr/bin/plutil -replace EnvironmentVariables.VRRELAY_RUNTIME_CONFIG -string "$TARGET_ROOT/data/runtime-config.json" "$NEXT_PLIST"
/usr/bin/plutil -replace EnvironmentVariables.VRRELAY_CACHE_DIR -string "$TARGET_CACHE" "$NEXT_PLIST"
/usr/bin/plutil -replace EnvironmentVariables.VRRELAY_FFMPEG -string "$TARGET_RUNTIME/bin/ffmpeg" "$NEXT_PLIST"
/usr/bin/plutil -replace EnvironmentVariables.VRRELAY_MEDIAMTX_EXECUTABLE -string "$TARGET_RUNTIME/bin/mediamtx" "$NEXT_PLIST"
/usr/bin/plutil -replace EnvironmentVariables.VRRELAY_MEDIAMTX_CONFIG -string "$TARGET_RUNTIME/mediamtx.yml" "$NEXT_PLIST"
/usr/bin/plutil -replace StandardOutPath -string "$TARGET_LOGS/service-supervisor.log" "$NEXT_PLIST"
/usr/bin/plutil -replace StandardErrorPath -string "$TARGET_LOGS/service-supervisor.log" "$NEXT_PLIST"

RUNTIME_CHANGED=1
if [[ -f "$TARGET_RUNTIME/build-id.txt" ]] && /usr/bin/cmp -s "$RESOURCE_ROOT/runtime/build-id.txt" "$TARGET_RUNTIME/build-id.txt"; then
  RUNTIME_CHANGED=0
fi
PLIST_CHANGED=1
if [[ -f "$TARGET_PLIST" ]] && /usr/bin/cmp -s "$NEXT_PLIST" "$TARGET_PLIST"; then
  PLIST_CHANGED=0
fi

if [[ "$RUNTIME_CHANGED" -eq 1 || "$PLIST_CHANGED" -eq 1 ]]; then
  /bin/launchctl bootout "$SERVICE_TARGET" 2>/dev/null || true
fi

if [[ "$RUNTIME_CHANGED" -eq 1 ]]; then
  NEXT_RUNTIME="$TARGET_ROOT/runtime.next"
  PREVIOUS_RUNTIME="$TARGET_ROOT/runtime.previous"
  /bin/rm -rf "$NEXT_RUNTIME" "$PREVIOUS_RUNTIME"
  /usr/bin/ditto "$RESOURCE_ROOT/runtime" "$NEXT_RUNTIME"
  if [[ -d "$TARGET_RUNTIME" ]]; then /bin/mv "$TARGET_RUNTIME" "$PREVIOUS_RUNTIME"; fi
  if ! /bin/mv "$NEXT_RUNTIME" "$TARGET_RUNTIME"; then
    [[ ! -d "$PREVIOUS_RUNTIME" ]] || /bin/mv "$PREVIOUS_RUNTIME" "$TARGET_RUNTIME"
    exit 1
  fi
  /bin/rm -rf "$PREVIOUS_RUNTIME"
fi

if [[ "$PLIST_CHANGED" -eq 1 ]]; then
  /bin/mv "$NEXT_PLIST" "$TARGET_PLIST"
  NEXT_PLIST=""
  /bin/chmod 0600 "$TARGET_PLIST"
fi

if ! /bin/launchctl print "$SERVICE_TARGET" >/dev/null 2>&1; then
  BOOTSTRAPPED=0
  for bootstrap_attempt in {1..20}; do
    if /bin/launchctl bootstrap "$SERVICE_DOMAIN" "$TARGET_PLIST" 2>/dev/null; then
      BOOTSTRAPPED=1
      break
    fi
    /bin/sleep 0.25
  done
  [[ "$BOOTSTRAPPED" -eq 1 ]] || /bin/launchctl bootstrap "$SERVICE_DOMAIN" "$TARGET_PLIST"
fi
/bin/launchctl enable "$SERVICE_TARGET"
if [[ "$ACTION" == "restart" ]]; then /bin/launchctl kickstart -k "$SERVICE_TARGET"; fi
