// SPDX-License-Identifier: GPL-3.0-or-later
import 'dotenv/config';
import { loadConfig } from './config.js';

const config = loadConfig();
if (process.argv[2] === 'migrate') {
  const [{ runMigrations }, { createRepository }] = await Promise.all([
    import('./composition/migration.js'),
    import('./composition/repository.js')
  ]);
  await runMigrations(config, createRepository);
} else {
  const { composeConfiguredRuntime } = await import('./composition/roots.js');
  await composeConfiguredRuntime(config);
}
