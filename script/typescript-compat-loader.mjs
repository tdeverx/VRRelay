// SPDX-License-Identifier: GPL-3.0-or-later
import { registerHooks } from 'node:module';

registerHooks({
  resolve(specifier, context, nextResolve) {
    const compatibleSpecifier = specifier.startsWith('typescript/')
      ? `typescript-compat/${specifier.slice('typescript/'.length)}`
      : specifier === 'typescript'
        ? 'typescript-compat'
        : specifier;
    return nextResolve(compatibleSpecifier, context);
  }
});
