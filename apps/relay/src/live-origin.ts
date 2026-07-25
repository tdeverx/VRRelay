// SPDX-License-Identifier: GPL-3.0-or-later

export function liveOriginSourceUrl(
  baseUrl: string,
  path: string,
  readToken: string,
  srtPassphrase?: string
): string {
  if (!/^live-[A-Za-z0-9_-]+$/.test(path)) throw new Error('Invalid live path');
  if (baseUrl.startsWith('srt://')) {
    const separator = baseUrl.includes('?') ? '&' : '?';
    const encryption = srtPassphrase ? `passphrase=${encodeURIComponent(srtPassphrase)}&` : '';
    return `${baseUrl}${separator}${encryption}streamid=read:${path}:vrrelay-read:${readToken}`;
  }
  const source = new URL(baseUrl);
  if (source.protocol !== 'rtsp:') throw new Error('Live origin must use RTSP or SRT');
  source.username = 'vrrelay-read';
  source.password = readToken;
  source.pathname = `${source.pathname.replace(/\/$/, '')}/${path}`;
  return source.toString();
}
