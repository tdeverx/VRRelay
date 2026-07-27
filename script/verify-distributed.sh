#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-3.0-or-later
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$root"

npm run test:local-cluster 2>&1 | tee local-cluster.log
npm run test:integration 2>&1 | tee acceptance.log
