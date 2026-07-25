// SPDX-License-Identifier: GPL-3.0-or-later
import { dirname } from 'node:path';
import { SupervisedChildProcess } from '@vrrelay/adapters';

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
  #process: SupervisedChildProcess | undefined;

  constructor(
    private readonly options: {
      executable: string;
      configPath: string;
      relayPort: number;
      onUnexpectedExit: (error: Error) => void;
    }
  ) {}

  running(): boolean {
    return this.#process?.running() ?? false;
  }

  async start(): Promise<void> {
    if (this.#process?.running()) return;
    const process = new SupervisedChildProcess({
      executable: this.options.executable,
      arguments: [this.options.configPath],
      spawnOptions: {
        cwd: dirname(this.options.configPath),
        env: mediaMtxEnvironment(this.options.relayPort),
        stdio: ['ignore', 'inherit', 'pipe'],
        windowsHide: true
      },
      gracefulStopMs: 5_000,
      maxStderrBytes: 32_768,
      redact: (value) =>
        value
          .replace(/([?&](?:pass(?:phrase|word)?|token|signature)=)[^&\s'"<>]*/gi, '$1[REDACTED]')
          .replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s'"<>]+/gi, '[REDACTED_URL]'),
      onUnexpectedExit: this.options.onUnexpectedExit
    });
    this.#process = process;
    await process.start();
  }

  async stop(): Promise<void> {
    await this.#process?.stop();
    this.#process = undefined;
  }
}
