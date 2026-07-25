// SPDX-License-Identifier: GPL-3.0-or-later

export const SIGNED_GRANT_MAX_PARAMETER_LENGTH = 1_024;

export function shouldRateLimitRequest(url: string): boolean {
  const path = url.split('?', 1)[0] ?? url;
  return ['/api', '/internal'].some((prefix) => path === prefix || path.startsWith(`${prefix}/`));
}

export function frameworkClientError(error: unknown):
  | {
      statusCode: number;
      code: 'rate_limited' | 'request_failed';
      message: string;
    }
  | undefined {
  if (typeof error !== 'object' || error === null || !('statusCode' in error)) return undefined;
  const statusCode = Number(error.statusCode);
  if (!Number.isInteger(statusCode) || statusCode < 400 || statusCode >= 500) return undefined;
  return {
    statusCode,
    code: statusCode === 429 ? 'rate_limited' : 'request_failed',
    message: statusCode === 429 ? 'Too many requests' : 'Request could not be completed'
  };
}
