#!/bin/sh
# SPDX-License-Identifier: GPL-3.0-or-later
set -eu
: "${POSTGRES_URL:?Set POSTGRES_URL}"
: "${BACKUP_DIR:?Set BACKUP_DIR}"
mkdir -p "$BACKUP_DIR"
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
pg_dump --format=custom --no-owner "$POSTGRES_URL" > "$BACKUP_DIR/vrrelay-$stamp.dump"
find "$BACKUP_DIR" -name 'vrrelay-*.dump' -mtime +"${RETENTION_DAYS:-14}" -delete
echo "$BACKUP_DIR/vrrelay-$stamp.dump"
