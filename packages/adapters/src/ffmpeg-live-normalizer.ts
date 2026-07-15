// SPDX-License-Identifier: GPL-3.0-or-later
import { spawn, type ChildProcess } from 'node:child_process';
import type { LiveNormalizer } from '@vrrelay/application';

export interface FFmpegLiveNormalizerOptions {
  ffmpegPath: string;
  videoEncoder: string;
  videoBitrateKbps?: number;
  audioBitrateKbps?: number;
}

export class FFmpegLiveNormalizer implements LiveNormalizer {
  readonly #processes = new Map<string, ChildProcess>();

  constructor(private readonly options: FFmpegLiveNormalizerOptions) {}

  running(channelId: string): boolean {
    return this.#processes.has(channelId);
  }

  async start(
    channelId: string,
    sourceUrl: string,
    destinationUrl: string,
    signal?: AbortSignal
  ): Promise<void> {
    await this.stop(channelId);
    const args = [
      '-hide_banner',
      '-loglevel',
      'warning',
      '-rtsp_transport',
      'tcp',
      '-i',
      sourceUrl,
      '-map',
      '0:v:0',
      '-map',
      '0:a:0?',
      '-c:v',
      this.options.videoEncoder,
      '-pix_fmt',
      'yuv420p',
      '-b:v',
      `${this.options.videoBitrateKbps ?? 6000}k`,
      '-maxrate',
      `${this.options.videoBitrateKbps ?? 6000}k`,
      '-bufsize',
      `${(this.options.videoBitrateKbps ?? 6000) * 2}k`,
      '-g',
      '60',
      '-keyint_min',
      '60',
      '-sc_threshold',
      '0',
      '-c:a',
      'aac',
      '-b:a',
      `${this.options.audioBitrateKbps ?? 192}k`,
      '-ar',
      '48000',
      '-ac',
      '2',
      '-f',
      'rtsp',
      '-rtsp_transport',
      'tcp',
      destinationUrl
    ];
    const child = spawn(this.options.ffmpegPath, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    this.#processes.set(channelId, child);
    child.once('exit', () => this.#processes.delete(channelId));
    signal?.addEventListener('abort', () => void this.stop(channelId), { once: true });
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        settled = true;
        resolve();
      }, 250);
      child.once('error', (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error);
      });
      child.once('exit', (code) => {
        if (!settled && code !== 0) {
          settled = true;
          clearTimeout(timer);
          reject(new Error(`Live normalizer exited during startup (${code})`));
        }
      });
    });
  }

  async stop(channelId: string): Promise<void> {
    const child = this.#processes.get(channelId);
    if (!child) return;
    this.#processes.delete(channelId);
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.kill('SIGTERM');
    const timer = setTimeout(() => child.kill('SIGKILL'), 3000);
    await new Promise<void>((resolve) => child.once('exit', () => resolve()));
    clearTimeout(timer);
  }
}
