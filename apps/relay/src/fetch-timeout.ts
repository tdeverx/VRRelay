// SPDX-License-Identifier: GPL-3.0-or-later

export function signalWithTimeout(timeoutMs: number, signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

export function fetchWithTimeout(
  input: string | URL | Request,
  init: RequestInit = {},
  timeoutMs = 10_000
): Promise<Response> {
  return fetch(input, {
    ...init,
    signal: signalWithTimeout(timeoutMs, init.signal ?? undefined)
  });
}
