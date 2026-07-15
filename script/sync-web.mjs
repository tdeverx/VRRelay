// SPDX-License-Identifier: GPL-3.0-or-later
import { cp, mkdir, rm } from 'node:fs/promises';

const source = new URL('../apps/web/build/', import.meta.url);
const destination = new URL('../apps/relay/public/', import.meta.url);

await rm(destination, { recursive: true, force: true });
await mkdir(destination, { recursive: true });
await cp(source, destination, { recursive: true });
