// SPDX-License-Identifier: GPL-3.0-or-later
import { spawn, type ChildProcess } from 'node:child_process';
import { dirname } from 'node:path';

export function mediaMtxEnvironment(
  relayPort: number,
  environment: NodeJS.ProcessEnv = process.env
): NodeJS.ProcessEnv {
  return {
    ...environment,
    MTX_AUTHMETHOD: environment.MTX_AUTHMETHOD ?? 'http',
    MTX_AUTHHTTPADDRESS:
      environment.MTX_AUTHHTTPADDRESS ?? `http://127.0.0.1:${relayPort}/internal/mediamtx/auth`,
    MTX_API: environment.MTX_API ?? 'yes',
    MTX_APIADDRESS: environment.MTX_APIADDRESS ?? '127.0.0.1:9997',
    MTX_HLSADDRESS: environment.MTX_HLSADDRESS ?? '127.0.0.1:8888',
    MTX_HLSVARIANT: environment.MTX_HLSVARIANT ?? 'mpegts',
    MTX_RTSPADDRESS: environment.MTX_RTSPADDRESS ?? '127.0.0.1:8554',
    MTX_RTMPADDRESS: environment.MTX_RTMPADDRESS ?? ':1935',
    MTX_SRTADDRESS: environment.MTX_SRTADDRESS ?? ':8890',
    MTX_WEBRTCADDRESS: environment.MTX_WEBRTCADDRESS ?? ':8889',
    MTX_WEBRTCLOCALUDPADDRESS: environment.MTX_WEBRTCLOCALUDPADDRESS ?? ':8189'
  };
}

export class ManagedMediaMtx {
  #child: ChildProcess | undefined;
  #stopping = false;

  constructor(
    private readonly options: {
      executable: string;
      configPath: string;
      relayPort: number;
      onUnexpectedExit: (error: Error) => void;
    }
  ) {}

  async start(): Promise<void> {
    if (this.#child) return;
    this.#stopping = false;
    const child = spawn(this.options.executable, [this.options.configPath], {
      cwd: dirname(this.options.configPath),
      env: mediaMtxEnvironment(this.options.relayPort),
      stdio: ['ignore', 'inherit', 'inherit'],
      windowsHide: true
    });
    this.#child = child;
    child.once('exit', (code, signal) => {
      this.#child = undefined;
      if (this.#stopping) return;
      this.options.onUnexpectedExit(
        new Error(`Managed MediaMTX exited unexpectedly (${signal ?? code ?? 'unknown'})`)
      );
    });
    await new Promise<void>((resolve, reject) => {
      const onSpawn = () => {
        child.off('error', onError);
        resolve();
      };
      const onError = (error: Error) => {
        child.off('spawn', onSpawn);
        this.#child = undefined;
        reject(error);
      };
      child.once('spawn', onSpawn);
      child.once('error', onError);
    });
  }

  async stop(): Promise<void> {
    this.#stopping = true;
    const child = this.#child;
    if (!child || child.exitCode !== null) return;
    const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
    child.kill('SIGTERM');
    const timer = setTimeout(() => child.kill('SIGKILL'), 5_000);
    timer.unref();
    await exited;
    clearTimeout(timer);
  }
}
