// SPDX-License-Identifier: GPL-3.0-or-later
import type { MediaProvider, ProviderRegistry } from '@vrrelay/application';
import type { ProviderType } from '@vrrelay/domain';

export class DefaultProviderRegistry implements ProviderRegistry {
  readonly #providers = new Map<ProviderType, MediaProvider>();

  register(provider: MediaProvider): void {
    this.#providers.set(provider.type, provider);
  }

  get(type: ProviderType): MediaProvider {
    const provider = this.#providers.get(type);
    if (!provider) throw new Error(`Provider adapter is not registered: ${type}`);
    return provider;
  }
}
