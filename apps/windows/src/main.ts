// SPDX-License-Identifier: GPL-3.0-or-later
import { app, BrowserWindow, Menu, Tray, nativeImage, shell } from 'electron';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const serviceName = 'VRRelay';
const dashboard = process.env.VRRELAY_PUBLIC_URL ?? 'http://127.0.0.1:8099';
let tray: Tray | undefined;
let window: BrowserWindow | undefined;

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

function showDashboard(): void {
  if (!window) {
    window = new BrowserWindow({
      width: 1180,
      height: 780,
      title: 'VRRelay',
      webPreferences: { sandbox: true }
    });
    window.on('closed', () => {
      window = undefined;
    });
  }
  void window.loadURL(dashboard);
  window.show();
}

async function refreshMenu(): Promise<void> {
  if (!tray) return;
  const status = await serviceState();
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: status, enabled: false },
      { type: 'separator' },
      { label: 'Show VRRelay', click: showDashboard },
      { label: 'Open in browser', click: () => void shell.openExternal(dashboard) },
      { type: 'separator' },
      { label: 'Start service', click: () => void service('start').then(refreshMenu) },
      {
        label: 'Restart service',
        click: () =>
          void service('stop')
            .catch(() => undefined)
            .then(() => service('start'))
            .then(refreshMenu)
      },
      { label: 'Stop service', click: () => void service('stop').then(refreshMenu) },
      { type: 'separator' },
      { label: 'Quit tray (service stays running)', click: () => app.quit() }
    ])
  );
}

void app.whenReady().then(() => {
  const icon = nativeImage.createEmpty();
  tray = new Tray(icon);
  tray.setToolTip('VRRelay');
  tray.on('double-click', showDashboard);
  void refreshMenu();
  setInterval(() => void refreshMenu(), 10_000).unref();
});

app.on('window-all-closed', () => undefined);
