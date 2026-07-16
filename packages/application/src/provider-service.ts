// SPDX-License-Identifier: GPL-3.0-or-later
import { randomUUID } from 'node:crypto';
import type {
  MediaItem,
  ProviderBinding,
  ProviderConnection,
  PublicProviderConnection
} from '@vrrelay/domain';
import { providerAllowsPublicHttp, publicProvider } from '@vrrelay/domain';
import type { CatalogQuery, CreateProviderRequest } from '@vrrelay/contracts';
import type {
  ClusterRepository,
  PlaybackEvent,
  ProviderRegistry,
  RemoteProviderGateway,
  Repository,
  SecretStore
} from './index.js';
import { ConflictError, NotFoundError } from './errors.js';

const MAX_PROVIDER_WRITE_ATTEMPTS = 5;

export type ProviderBindingCreation =
  | { mode: 'new'; expectedProviderRevision: null }
  | { mode: 'existing'; expectedProviderRevision: number };

function providersReferenceSameServer(
  current: ProviderConnection,
  candidate: ProviderConnection
): boolean {
  return (
    current.id === candidate.id &&
    current.type === candidate.type &&
    current.baseUrl.replace(/\/+$/, '') === candidate.baseUrl.replace(/\/+$/, '') &&
    providerAllowsPublicHttp(current) === providerAllowsPublicHttp(candidate)
  );
}

function bindingMatchesAttempt(
  current: ProviderBinding,
  candidate: ProviderBinding,
  provider: ProviderConnection | undefined,
  candidateProvider: ProviderConnection
): provider is ProviderConnection {
  return Boolean(
    provider &&
    !current.deletionPending &&
    providersReferenceSameServer(provider, candidateProvider) &&
    current.id === candidate.id &&
    current.providerId === candidate.providerId &&
    current.nodeId === candidate.nodeId
  );
}

export class ProviderService {
  constructor(
    private readonly repository: Repository & Partial<ClusterRepository>,
    private readonly secrets: SecretStore,
    private readonly providers: ProviderRegistry,
    private readonly options: { nodeId?: string; remote?: RemoteProviderGateway } = {}
  ) {}

  async create(
    input: CreateProviderRequest & { normalizedBaseUrl: string; securityNotice?: string }
  ): Promise<PublicProviderConnection> {
    const adapter = this.providers.get(input.type);
    const identity = await adapter.authenticate(
      input.normalizedBaseUrl,
      {
        ...(input.authMode === 'api_key'
          ? { apiKey: input.apiKey! }
          : { username: input.username!, password: input.password! })
      },
      undefined,
      { allowPublicHttp: input.allowPublicHttp }
    );
    const id = randomUUID();
    const now = new Date().toISOString();
    const connection: ProviderConnection = {
      id,
      type: input.type,
      name: input.name,
      baseUrl: input.normalizedBaseUrl,
      authMode: input.authMode,
      secretRef: `provider:${id}`,
      ...(identity.userId ? { userId: identity.userId } : {}),
      ...(identity.username ? { username: identity.username } : {}),
      serverName: identity.serverName,
      serverVersion: identity.serverVersion,
      capabilities: [...adapter.capabilities],
      healthy: true,
      allowPublicHttp: input.allowPublicHttp,
      ...(input.securityNotice ? { securityNotice: input.securityNotice } : {}),
      createdAt: now,
      updatedAt: now
    };
    await this.secrets.put(connection.secretRef, identity.accessToken);
    try {
      await this.repository.createProvider(connection);
    } catch (error) {
      let current: ProviderConnection | undefined;
      try {
        current = await this.repository.getProvider(connection.id);
      } catch {
        // The insert may have committed even though its acknowledgement was
        // lost. Keep the staged secret until the outcome can be reconciled.
        throw error;
      }
      if (current?.secretRef === connection.secretRef) return publicProvider(current);
      await this.secrets.delete(connection.secretRef);
      throw error;
    }
    return publicProvider(connection);
  }

  async list(): Promise<PublicProviderConnection[]> {
    return (await this.repository.listProviders()).map(publicProvider);
  }

  async delete(providerId: string): Promise<void> {
    const deleting = await this.#beginDeletion(providerId);
    if (!deleting) return;
    // SecretStore.delete is deliberately idempotent. If it fails, the durable
    // deletion marker remains and a later request resumes at this step.
    await this.secrets.delete(deleting.value.secretRef);
    await this.#finalizeDeletion(providerId, deleting.revision);
  }

  async createBinding(
    input: CreateProviderRequest & { normalizedBaseUrl: string; securityNotice?: string },
    nodeId: string,
    providerId: string,
    bindingId: string,
    creation: ProviderBindingCreation
  ): Promise<{ provider: PublicProviderConnection; binding: ProviderBinding }> {
    const adapter = this.providers.get(input.type);
    const identity = await adapter.authenticate(
      input.normalizedBaseUrl,
      input.authMode === 'api_key'
        ? { apiKey: input.apiKey! }
        : { username: input.username!, password: input.password! },
      undefined,
      { allowPublicHttp: input.allowPublicHttp }
    );
    const now = new Date().toISOString();
    const secretRef = `provider-binding:${bindingId}:${randomUUID()}`;
    const authenticated: ProviderConnection = {
      id: providerId,
      type: input.type,
      name: input.name,
      baseUrl: input.normalizedBaseUrl,
      authMode: input.authMode,
      secretRef,
      ...(identity.userId ? { userId: identity.userId } : {}),
      ...(identity.username ? { username: identity.username } : {}),
      serverName: identity.serverName,
      serverVersion: identity.serverVersion,
      capabilities: [...adapter.capabilities],
      healthy: true,
      allowPublicHttp: input.allowPublicHttp,
      ...(input.securityNotice ? { securityNotice: input.securityNotice } : {}),
      createdAt: now,
      updatedAt: now
    };
    const binding: ProviderBinding = {
      id: bindingId,
      providerId,
      nodeId,
      secretRef,
      reachable: true,
      state: 'healthy',
      deletionPending: false,
      validatedAt: now,
      createdAt: now,
      updatedAt: now
    };
    const createProviderBinding = this.repository.createProviderBinding?.bind(this.repository);
    const getProviderBinding = this.repository.getProviderBinding?.bind(this.repository);
    if (!createProviderBinding || !getProviderBinding)
      throw new Error('The configured repository does not support provider bindings');
    await this.secrets.put(secretRef, identity.accessToken);
    try {
      const result = await createProviderBinding(
        authenticated,
        binding,
        creation.mode === 'new' ? null : creation.expectedProviderRevision
      );
      if (!result.applied) {
        if (
          result.binding &&
          bindingMatchesAttempt(result.binding.value, binding, result.provider, authenticated)
        ) {
          if (result.binding.value.secretRef !== secretRef) await this.secrets.delete(secretRef);
          return {
            provider: publicProvider(result.provider),
            binding: result.binding.value
          };
        }
        await this.secrets.delete(secretRef);
        switch (result.reason) {
          case 'provider-not-found':
            throw new NotFoundError('Provider connection was not found');
          case 'provider-conflict':
            throw new ConflictError('Failover bindings must reference the same provider server');
          case 'provider-revision-conflict':
            throw new ConflictError(
              'Provider connection changed while the binding was being created'
            );
          case 'provider-deleting':
            throw new ConflictError('Provider connection is being deleted');
          case 'binding-deleting':
            throw new ConflictError('Provider binding credential cleanup is already pending');
          case 'node-unavailable':
            throw new ConflictError('Selected source worker is unavailable');
          case 'binding-conflict':
            throw new ConflictError('A provider binding with this identifier already exists');
        }
      }
      return { provider: publicProvider(result.provider), binding: result.binding.value };
    } catch (error) {
      let currentBinding: ProviderBinding | undefined;
      let currentProvider: ProviderConnection | undefined;
      try {
        [currentBinding, currentProvider] = await Promise.all([
          getProviderBinding(bindingId),
          this.repository.getProvider(providerId)
        ]);
      } catch {
        // The commit outcome is ambiguous. Retain the staged credential so a
        // later reconciliation can repair or remove it safely.
        throw error;
      }
      if (
        currentBinding &&
        bindingMatchesAttempt(currentBinding, binding, currentProvider, authenticated)
      ) {
        if (currentBinding.secretRef !== secretRef) await this.secrets.delete(secretRef);
        return { provider: publicProvider(currentProvider), binding: currentBinding };
      }
      if (!currentBinding || currentBinding.secretRef !== secretRef)
        await this.secrets.delete(secretRef);
      throw error;
    }
  }

  async removeBinding(bindingId: string): Promise<void> {
    const binding = await this.repository.getProviderBinding?.(bindingId, {
      includeDeletionPending: true
    });
    if (!binding) throw new NotFoundError('Provider binding was not found');
    if (!binding.deletionPending)
      throw new ConflictError(
        'Provider binding credential cleanup must be authorized by the controller first'
      );
    await this.secrets.delete(binding.secretRef);
  }

  async browse(
    providerId: string,
    query: CatalogQuery
  ): Promise<{ items: MediaItem[]; total: number }> {
    const connection = await this.#connection(providerId);
    const remote = await this.#remoteBinding(providerId);
    if (remote)
      return this.options.remote!.call(remote.nodeId, 'provider.browse', { providerId, query });
    const secret = await this.secrets.get(await this.#localSecretRef(connection));
    return this.providers.get(connection.type).browse(connection, secret, query);
  }

  async item(providerId: string, itemId: string): Promise<MediaItem> {
    const connection = await this.#connection(providerId);
    const remote = await this.#remoteBinding(providerId);
    if (remote)
      return this.options.remote!.call(remote.nodeId, 'provider.item', { providerId, itemId });
    const secret = await this.secrets.get(await this.#localSecretRef(connection));
    return this.providers.get(connection.type).item(connection, secret, itemId);
  }

  async validate(providerId: string): Promise<void> {
    const connection = await this.#connection(providerId);
    const remote = await this.#remoteBinding(providerId);
    if (remote) {
      await this.options.remote!.call(remote.nodeId, 'provider.validate', { providerId });
    } else {
      const secret = await this.secrets.get(await this.#localSecretRef(connection));
      await this.providers.get(connection.type).validate(connection, secret);
    }
    await this.#markHealthy(providerId);
  }

  async reportActivity(providerId: string, event: PlaybackEvent): Promise<void> {
    const connection = await this.#connection(providerId);
    const remote = await this.#remoteBinding(providerId);
    if (remote) {
      await this.options.remote!.call(remote.nodeId, 'provider.activity', {
        providerId,
        ...event
      });
      return;
    }
    const secret = await this.secrets.get(await this.#localSecretRef(connection));
    await this.providers.get(connection.type).reportPlayback(connection, secret, event);
  }

  async #connection(id: string): Promise<ProviderConnection> {
    const connection = await this.repository.getProvider(id);
    if (!connection) throw new NotFoundError('Provider connection was not found');
    return connection;
  }

  async #markHealthy(providerId: string): Promise<void> {
    for (let attempt = 0; attempt < MAX_PROVIDER_WRITE_ATTEMPTS; attempt += 1) {
      const current = await this.repository.getVersionedProvider(providerId);
      if (!current) throw new NotFoundError('Provider connection was not found');
      const result = await this.repository.compareAndSetProvider(
        {
          ...current.value,
          healthy: true,
          updatedAt: new Date().toISOString()
        },
        current.revision
      );
      if (result.applied) return;
      if (result.reason === 'not-found')
        throw new NotFoundError('Provider connection was not found');
      if (result.reason === 'invalid-state')
        throw new ConflictError('Provider connection is being deleted');
    }
    throw new ConflictError('Provider validation conflicted with repeated concurrent updates');
  }

  async #beginDeletion(providerId: string) {
    for (let attempt = 0; attempt < MAX_PROVIDER_WRITE_ATTEMPTS; attempt += 1) {
      const result = await this.repository.beginProviderDeletion(providerId);
      if (result.applied) return result.record;
      // A provider that is absent from the active view is either already
      // finalized or was never present. DELETE is intentionally idempotent.
      if (result.reason === 'not-found') return undefined;
      if (result.reason === 'dependency-conflict')
        throw new ConflictError('Delete every session and node binding for this provider first');
      if (result.reason === 'invalid-state')
        throw new ConflictError('Provider deletion is not allowed in its current state');
    }
    throw new ConflictError('Provider deletion conflicted with repeated concurrent updates');
  }

  async #finalizeDeletion(providerId: string, initialRevision: number): Promise<void> {
    let expectedRevision = initialRevision;
    for (let attempt = 0; attempt < MAX_PROVIDER_WRITE_ATTEMPTS; attempt += 1) {
      try {
        const result = await this.repository.finalizeProviderDeletion(providerId, expectedRevision);
        if (result.applied || result.reason === 'not-found') return;
        if (result.reason === 'dependency-conflict')
          throw new ConflictError('Delete every session and node binding for this provider first');
      } catch (error) {
        if (error instanceof ConflictError) throw error;
      }
      // Active-provider reads intentionally hide deletion-pending records.
      // Re-enter the atomic begin operation to determine whether finalize
      // committed and lost its acknowledgement, or still needs retrying.
      const pending = await this.#beginDeletion(providerId);
      if (!pending) return;
      expectedRevision = pending.revision;
    }
    throw new ConflictError('Provider deletion conflicted with repeated concurrent updates');
  }

  async #remoteBinding(providerId: string): Promise<ProviderBinding | undefined> {
    if (!this.options.remote || !this.repository.listProviderBindings) return undefined;
    const bindings = await this.repository.listProviderBindings(providerId);
    const remote = bindings.find(
      (binding) =>
        binding.state === 'healthy' &&
        !binding.deletionPending &&
        binding.nodeId !== this.options.nodeId &&
        this.options.remote!.connected(binding.nodeId)
    );
    return remote;
  }

  async #localSecretRef(connection: ProviderConnection): Promise<string> {
    if (!this.repository.listProviderBindings) return connection.secretRef;
    const bindings = await this.repository.listProviderBindings(connection.id);
    const candidates = [
      ...bindings.filter(
        (binding) =>
          binding.nodeId === this.options.nodeId &&
          binding.state === 'healthy' &&
          !binding.deletionPending
      ),
      ...bindings.filter(
        (binding) =>
          binding.nodeId !== this.options.nodeId &&
          binding.state === 'healthy' &&
          !binding.deletionPending
      )
    ];
    // Enrollment can replace a node's bootstrap ID with a controller-issued ID.
    // The secret backend is the authority for locality: only the worker that
    // received this binding can resolve its reference.
    for (const binding of candidates) {
      try {
        await this.secrets.get(binding.secretRef);
        return binding.secretRef;
      } catch {
        // This binding belongs to a different node.
      }
    }
    return connection.secretRef;
  }
}
