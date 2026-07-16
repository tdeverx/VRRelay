// SPDX-License-Identifier: GPL-3.0-or-later
import { app, Menu, Tray, nativeImage, shell } from 'electron';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const serviceName = 'VRRelay';
const dashboard = process.env.VRRELAY_PUBLIC_URL ?? 'http://127.0.0.1:8099';
let tray: Tray | undefined;

async function service(command: 'start' | 'stop'): Promise<void> {
  await exec('sc.exe', [command, serviceName], { windowsHide: true });
}

async function serviceState(): Promise<string> {
  try {
    const { stdout } = await exec('sc.exe', ['query', serviceName], { windowsHide: true });
    return stdout.includes('RUNNING') ? 'Running as a Windows service' : 'Service is stopped';
  } catch {
    return 'Service is not installed';
  }
}

async function refreshMenu(): Promise<void> {
  if (!tray) return;
  const status = await serviceState();
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: status, enabled: false },
      { type: 'separator' },
      { label: 'Open Dashboard', click: () => void shell.openExternal(dashboard) },
      { type: 'separator' },
      { label: 'Start Relay', click: () => void service('start').then(refreshMenu) },
      { label: 'Stop Relay', click: () => void service('stop').then(refreshMenu) },
      {
        label: 'Restart Relay',
        click: () =>
          void service('stop')
            .catch(() => undefined)
            .then(() => service('start'))
            .then(refreshMenu)
      },
      { type: 'separator' },
      { label: 'Quit VRRelay', click: () => app.quit() }
    ])
  );
}

void app.whenReady().then(async () => {
  const icon = await nativeImage.createThumbnailFromPath(process.execPath, {
    width: 16,
    height: 16
  });
  tray = new Tray(icon);
  tray.setToolTip('VRRelay');
  tray.on('double-click', () => void shell.openExternal(dashboard));
  void refreshMenu();
  setInterval(() => void refreshMenu(), 10_000).unref();
});
