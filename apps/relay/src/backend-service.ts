// SPDX-License-Identifier: GPL-3.0-or-later
import { z } from 'zod';
import type { BackendStatus, BackendKind } from '@vrrelay/domain';
import {
  BuiltinTrafficDirector,
  ConflictError,
  StaticTrafficDirector,
  SwitchableMetricsExporter,
  SwitchableTrafficDirector,
  type CoordinationStore,
  type MetricsSink,
  type ObjectStore,
  type Repository,
  type SecretStore,
  type TrafficDirector
} from '@vrrelay/application';
import {
  AzureBlobObjectStore,
  GcsObjectStore,
  S3ObjectStore,
  validateProviderUrl,
  WebhookMetricsExporter,
  WebhookTrafficDirector
} from '@vrrelay/adapters';
import { BackendValidationRequestSchema, type BackendValidationRequest } from '@vrrelay/contracts';

const ROUTING_SETTING = 'backend.routing';
const METRICS_SETTING = 'backend.metrics';
export const OBJECT_STORE_SETTING = 'backend.object-store';
export const OBJECT_STORE_APPLIED_SETTING = 'backend.object-store.applied';

const S3SecretSchema = z.object({
  accessKeyId: z.string().min(1),
  secretAccessKey: z.string().min(1)
});
const AzureSecretSchema = z.object({
  accountName: z.string().min(1),
  accountKey: z.string().min(1)
});
const GcsSecretSchema = z.object({
  client_email: z.string().min(1),
  private_key: z.string().min(1)
});

export interface BackendServiceOptions {
  repositoryKind: 'sqlite' | 'postgres';
  secretKind: 'keychain' | 'dpapi' | 'encrypted-file';
  localObjectStore?: ObjectStore;
  metrics: MetricsSink;
  nodeId?: string;
}

export function objectStoreAppliedSetting(nodeId: string): string {
  return `${OBJECT_STORE_APPLIED_SETTING}.${nodeId}`;
}

async function secretJson<T>(
  secrets: SecretStore,
  reference: string | undefined,
  schema: z.ZodType<T>,
  description: string
): Promise<T | undefined> {
  if (!reference) return undefined;
  try {
    return schema.parse(JSON.parse(await secrets.get(reference)));
  } catch {
    throw new ConflictError(
      `${description} secret reference must contain the documented JSON credential fields`
    );
  }
}

export async function createConfiguredObjectStore(
  configuration: BackendValidationRequest,
  secrets: SecretStore,
  localObjectStore: ObjectStore
): Promise<ObjectStore> {
  if (configuration.category !== 'object-store')
    throw new ConflictError('Object-store configuration has an invalid category');
  switch (configuration.kind) {
    case 'local':
      return localObjectStore;
    case 's3': {
      if (!configuration.bucket) throw new ConflictError('S3 bucket is required');
      const credentials = await secretJson(secrets, configuration.secretRef, S3SecretSchema, 'S3');
      const endpoint = configuration.endpoint
        ? (await validateProviderUrl(configuration.endpoint)).normalizedUrl
        : undefined;
      return new S3ObjectStore({
        bucket: configuration.bucket,
        ...(configuration.region ? { region: configuration.region } : {}),
        ...(configuration.prefix ? { prefix: configuration.prefix } : {}),
        ...(endpoint ? { endpoint } : {}),
        ...(configuration.forcePathStyle !== undefined
          ? { forcePathStyle: configuration.forcePathStyle }
          : {}),
        ...(credentials ?? {})
      });
    }
    case 'azure-blob': {
      if (!configuration.endpoint) throw new ConflictError('Azure Blob account URL is required');
      const container = configuration.container ?? configuration.bucket;
      if (!container) throw new ConflictError('Azure Blob container is required');
      const credentials = await secretJson(
        secrets,
        configuration.secretRef,
        AzureSecretSchema,
        'Azure Blob'
      );
      return new AzureBlobObjectStore({
        accountUrl: (await validateProviderUrl(configuration.endpoint)).normalizedUrl,
        container,
        ...(configuration.prefix ? { prefix: configuration.prefix } : {}),
        ...(credentials ?? {})
      });
    }
    case 'gcs': {
      if (!configuration.bucket) throw new ConflictError('GCS bucket is required');
      const credentials = await secretJson(
        secrets,
        configuration.secretRef,
        GcsSecretSchema,
        'GCS'
      );
      return new GcsObjectStore({
        bucket: configuration.bucket,
        ...(configuration.projectId ? { projectId: configuration.projectId } : {}),
        ...(configuration.prefix ? { prefix: configuration.prefix } : {}),
        ...(credentials ? { credentials } : {})
      });
    }
    default:
      throw new ConflictError('Object-store backend must be local, s3, azure-blob, or gcs');
  }
}

export async function resolveConfiguredObjectStore(
  repository: Repository,
  secrets: SecretStore,
  localObjectStore: ObjectStore,
  bootstrapObjectStore: ObjectStore,
  nodeId = 'local'
): Promise<ObjectStore> {
  const serialized = await repository.getSetting(OBJECT_STORE_SETTING);
  if (!serialized) return bootstrapObjectStore;
  const configuration = BackendValidationRequestSchema.parse(JSON.parse(serialized));
  const objectStore = await createConfiguredObjectStore(configuration, secrets, localObjectStore);
  const status = await objectStore.health();
  if (!status.healthy)
    throw new Error(status.message ?? `Configured ${configuration.kind} object store is unhealthy`);
  await repository.putSetting(objectStoreAppliedSetting(nodeId), JSON.stringify(configuration));
  return objectStore;
}

export class BackendService {
  #activationTail: Promise<void> = Promise.resolve();
  #closed = false;
  #closePromise: Promise<void> | undefined;

  constructor(
    private readonly repository: Repository,
    private readonly secrets: SecretStore,
    private readonly objectStore: ObjectStore,
    private readonly coordination: CoordinationStore,
    private readonly routing: SwitchableTrafficDirector,
    private readonly metricsExporter: SwitchableMetricsExporter,
    private readonly options: BackendServiceOptions
  ) {}

  async load(): Promise<void> {
    const [serializedRouting, serializedMetrics] = await Promise.all([
      this.repository.getSetting(ROUTING_SETTING),
      this.repository.getSetting(METRICS_SETTING)
    ]);
    if (serializedRouting) {
      const configuration = BackendValidationRequestSchema.parse(JSON.parse(serializedRouting));
      if (configuration.category !== 'routing')
        throw new Error('Persisted routing backend has an invalid category');
      this.routing.activate(await this.#routingCandidate(configuration));
    }
    if (serializedMetrics) {
      const configuration = BackendValidationRequestSchema.parse(JSON.parse(serializedMetrics));
      if (configuration.category !== 'metrics')
        throw new Error('Persisted metrics backend has an invalid category');
      await this.metricsExporter.activate(await this.#metricsCandidate(configuration));
    }
  }

  async list(): Promise<{ items: BackendStatus[]; restartRequired: boolean }> {
    const nodeId = this.options.nodeId ?? 'local';
    const [objectStore, coordination, routing, metrics, pendingObjectStore, appliedObjectStore] =
      await Promise.all([
        this.objectStore.health(),
        this.coordination.health(),
        this.routing.health(),
        this.metricsExporter.health(),
        this.repository.getSetting(OBJECT_STORE_SETTING),
        this.repository.getSetting(objectStoreAppliedSetting(nodeId))
      ]);
    const restartRequired = Boolean(
      pendingObjectStore && pendingObjectStore !== appliedObjectStore
    );
    const reportedObjectStore: BackendStatus = restartRequired
      ? {
          ...objectStore,
          message: `${objectStore.kind} is active; a validated replacement is staged`,
          restartRequired: true
        }
      : objectStore;
    const now = new Date().toISOString();
    return {
      items: [
        reportedObjectStore,
        coordination,
        {
          category: 'repository',
          kind: this.options.repositoryKind,
          healthy: true,
          message: 'Authoritative session and cluster state',
          checkedAt: now
        },
        routing,
        {
          category: 'secrets',
          kind: this.options.secretKind,
          healthy: true,
          message: 'Node-local root secret backend',
          checkedAt: now
        },
        metrics
      ],
      restartRequired
    };
  }

  async validate(configuration: BackendValidationRequest): Promise<BackendStatus> {
    if (configuration.category === 'object-store')
      return (
        await createConfiguredObjectStore(
          configuration,
          this.secrets,
          this.options.localObjectStore ?? this.objectStore
        )
      ).health();
    if (configuration.category === 'coordination' && configuration.kind === this.coordination.kind)
      return this.coordination.health();
    if (configuration.category === 'routing')
      return (await this.#routingCandidate(configuration)).health();
    if (configuration.category === 'metrics') {
      const candidate = await this.#metricsCandidate(configuration);
      return candidate
        ? candidate.health()
        : this.#staticStatus(
            'metrics',
            'prometheus',
            true,
            'Prometheus exposition endpoint active'
          );
    }
    if (
      (configuration.category === 'repository' &&
        configuration.kind === this.options.repositoryKind) ||
      (configuration.category === 'secrets' && configuration.kind === this.options.secretKind)
    )
      return this.#staticStatus(configuration.category, configuration.kind, true);
    return this.#staticStatus(
      configuration.category,
      configuration.kind,
      false,
      'This backend must be bootstrap-configured before it can be validated.',
      true
    );
  }

  async activate(configuration: BackendValidationRequest): Promise<BackendStatus> {
    if (this.#closed) throw new ConflictError('Backend service is closed');
    const activation = this.#activationTail.then(() => this.#activate(configuration));
    this.#activationTail = activation.then(
      () => undefined,
      () => undefined
    );
    return activation;
  }

  async #activate(configuration: BackendValidationRequest): Promise<BackendStatus> {
    if (configuration.category === 'object-store') {
      const candidate = await createConfiguredObjectStore(
        configuration,
        this.secrets,
        this.options.localObjectStore ?? this.objectStore
      );
      const status = await candidate.health();
      if (!status.healthy) throw new ConflictError(status.message ?? 'Object store is unhealthy');
      await this.#persistDesired(OBJECT_STORE_SETTING, configuration);
      return {
        ...status,
        message: 'Validated and staged; restart every relay role to activate this object store',
        restartRequired: true
      };
    }
    if (configuration.category === 'metrics') {
      const candidate = await this.#metricsCandidate(configuration);
      const status = candidate
        ? await candidate.health()
        : this.#staticStatus(
            'metrics',
            'prometheus',
            true,
            'Prometheus exposition endpoint active'
          );
      if (!status.healthy)
        throw new ConflictError(status.message ?? 'Metrics backend is unhealthy');
      const transition = await this.#persistDesired(METRICS_SETTING, configuration, {
        category: 'metrics',
        kind: 'prometheus'
      });
      try {
        await this.metricsExporter.activate(candidate);
      } catch (error) {
        await this.#rollbackDesired(METRICS_SETTING, transition, error);
      }
      return status;
    }
    if (configuration.category !== 'routing')
      return this.#staticStatus(
        configuration.category,
        configuration.kind,
        false,
        'This backend cannot be hot-swapped and requires bootstrap configuration plus a restart.',
        true
      );
    const candidate = await this.#routingCandidate(configuration);
    const status = await candidate.health();
    if (!status.healthy) throw new ConflictError(status.message ?? 'Routing backend is unhealthy');
    const transition = await this.#persistDesired(ROUTING_SETTING, configuration, {
      category: 'routing',
      kind: 'builtin'
    });
    try {
      this.routing.activate(candidate);
    } catch (error) {
      await this.#rollbackDesired(ROUTING_SETTING, transition, error);
    }
    return status;
  }

  async #persistDesired(
    key: string,
    configuration: BackendValidationRequest,
    defaultConfiguration?: BackendValidationRequest
  ): Promise<{ changed: boolean; revision: number; previousValue: string }> {
    const value = JSON.stringify(configuration);
    const current = await this.repository.getVersionedSetting(key);
    if (!current) {
      const inserted = await this.repository.putSettingIfAbsent(key, value);
      if (!inserted.inserted && inserted.record.value !== value)
        throw new ConflictError('Backend configuration changed concurrently; validate and retry');
      return {
        changed: inserted.inserted,
        revision: inserted.record.revision,
        previousValue: JSON.stringify(defaultConfiguration ?? configuration)
      };
    }
    if (current.value === value)
      return { changed: false, revision: current.revision, previousValue: current.value };
    const updated = await this.repository.compareAndSetSetting(key, value, current.revision);
    if (!updated.applied) {
      if (updated.current?.value === value)
        return {
          changed: false,
          revision: updated.current.revision,
          previousValue: updated.current.value
        };
      throw new ConflictError('Backend configuration changed concurrently; validate and retry');
    }
    return {
      changed: true,
      revision: updated.record.revision,
      previousValue: current.value
    };
  }

  async #rollbackDesired(
    key: string,
    transition: { changed: boolean; revision: number; previousValue: string },
    activationError: unknown
  ): Promise<never> {
    if (!transition.changed) throw activationError;
    let rollback;
    try {
      rollback = await this.repository.compareAndSetSetting(
        key,
        transition.previousValue,
        transition.revision
      );
    } catch (rollbackError) {
      throw new AggregateError(
        [activationError, rollbackError],
        'Backend activation failed and desired-state rollback could not be written',
        { cause: activationError }
      );
    }
    if (!rollback.applied)
      throw new AggregateError(
        [activationError],
        'Backend activation failed and desired state changed before rollback',
        { cause: activationError }
      );
    throw activationError;
  }

  async #routingCandidate(configuration: BackendValidationRequest): Promise<TrafficDirector> {
    if (configuration.kind === 'builtin') return new BuiltinTrafficDirector();
    if (configuration.kind === 'static') {
      if (!configuration.nodeId && !configuration.region)
        throw new ConflictError('Static routing requires a nodeId or region');
      return new StaticTrafficDirector({
        ...(configuration.nodeId ? { nodeId: configuration.nodeId } : {}),
        ...(configuration.region ? { region: configuration.region } : {})
      });
    }
    if (configuration.kind !== 'webhook')
      throw new ConflictError('Routing backend must be builtin, static, or webhook');
    if (!configuration.endpoint) throw new ConflictError('Routing webhook endpoint is required');
    const endpoint = (await validateProviderUrl(configuration.endpoint)).normalizedUrl;
    const token = configuration.secretRef
      ? await this.secrets.get(configuration.secretRef)
      : undefined;
    return new WebhookTrafficDirector({ endpoint, ...(token ? { token } : {}) });
  }

  async #metricsCandidate(configuration: BackendValidationRequest) {
    if (configuration.kind === 'prometheus') return undefined;
    if (configuration.kind !== 'webhook')
      throw new ConflictError('Metrics backend must be prometheus or webhook');
    if (!configuration.endpoint) throw new ConflictError('Metrics webhook endpoint is required');
    const endpoint = (await validateProviderUrl(configuration.endpoint)).normalizedUrl;
    const token = configuration.secretRef
      ? await this.secrets.get(configuration.secretRef)
      : undefined;
    return new WebhookMetricsExporter(this.options.metrics, {
      endpoint,
      ...(token ? { token } : {}),
      ...(configuration.intervalSeconds
        ? { intervalMs: configuration.intervalSeconds * 1_000 }
        : {})
    });
  }

  async close(): Promise<void> {
    this.#closed = true;
    if (!this.#closePromise) {
      const closeOperation = this.#activationTail.then(() => this.metricsExporter.stop());
      this.#activationTail = closeOperation.then(
        () => undefined,
        () => undefined
      );
      this.#closePromise = closeOperation;
    }
    const closeOperation = this.#closePromise;
    try {
      await closeOperation;
    } catch (error) {
      if (this.#closePromise === closeOperation) this.#closePromise = undefined;
      throw error;
    }
  }

  #staticStatus(
    category: BackendStatus['category'],
    kind: BackendKind,
    healthy: boolean,
    message?: string,
    restartRequired = false
  ): BackendStatus {
    return {
      category,
      kind,
      healthy,
      ...(message ? { message } : {}),
      checkedAt: new Date().toISOString(),
      ...(restartRequired ? { restartRequired } : {})
    };
  }
}
