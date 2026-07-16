// SPDX-License-Identifier: GPL-3.0-or-later
import {
  parseCookie,
  stringifySetCookie,
  type Cookies,
  type ParseOptions,
  type SerializeOptions
} from 'cookie-latest';

export function parse(value: string, options?: ParseOptions): Cookies {
  return parseCookie(value, options);
}

export function serialize(name: string, value: string, options: SerializeOptions = {}): string {
  return stringifySetCookie({ name, value, ...options });
}
