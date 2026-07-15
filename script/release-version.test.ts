// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { normalizeReleaseVersion } from './release-version.mjs';

describe('release version', () => {
  it('normalizes a tagged stable version', () => {
    expect(normalizeReleaseVersion('v1.2.3')).toBe('1.2.3');
  });

  it('accepts prerelease versions', () => {
    expect(normalizeReleaseVersion('1.2.3-rc.1')).toBe('1.2.3-rc.1');
  });

  it.each(['', 'v1.2', '01.2.3', 'release-1.2.3'])('rejects %s', (value) => {
    expect(() => normalizeReleaseVersion(value)).toThrow();
  });
});
