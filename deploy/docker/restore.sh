#!/bin/sh
# SPDX-License-Identifier: GPL-3.0-or-later
set -eu
: "${POSTGRES_URL:?Set POSTGRES_URL}"
: "${1:?Usage: restore.sh backup.dump}"
pg_restore --clean --if-exists --no-owner --dbname="$POSTGRES_URL" "$1"
