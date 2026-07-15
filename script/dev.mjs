// SPDX-License-Identifier: GPL-3.0-or-later
import { spawn } from 'node:child_process';

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const workspaces = [
  '@vrrelay/domain',
  '@vrrelay/contracts',
  '@vrrelay/application',
  '@vrrelay/adapters',
  '@vrrelay/relay',
  '@vrrelay/web'
];
const children = workspaces.map((workspace) =>
  spawn(npm, ['run', 'dev', '--workspace', workspace], {
    cwd: new URL('..', import.meta.url),
    stdio: 'inherit'
  })
);

const stop = () => children.forEach((child) => child.kill('SIGTERM'));
process.once('SIGINT', stop);
process.once('SIGTERM', stop);

const result = await Promise.race(
  children.map(
    (child, index) =>
      new Promise((resolve) => {
        child.once('error', (error) => resolve({ code: 1, error, workspace: workspaces[index] }));
        child.once('exit', (code, signal) =>
          resolve({ code: code ?? (signal ? 1 : 0), signal, workspace: workspaces[index] })
        );
      })
  )
);
stop();

if (result.error) console.error(`Failed to start ${result.workspace}:`, result.error);
if (result.code !== 0) process.exitCode = result.code;
