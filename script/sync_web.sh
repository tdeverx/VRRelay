#!/bin/sh
# SPDX-License-Identifier: GPL-3.0-or-later
set -eu
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
node "$ROOT/script/sync-web.mjs"
