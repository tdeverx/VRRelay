// SPDX-License-Identifier: GPL-3.0-or-later
import { join } from 'node:path';
import {
  AzureBlobObjectStore,
  EncryptedFileSecretStore,
  GcsObjectStore,
  LocalObjectStore,
  MacKeychainSecretStore,
  MemoryCoordinationStore,
  RedisCoordinationStore,
  S3ObjectStore,
  WindowsDpapiSecretStore
} from '@vrrelay/adapters';
import type { CoordinationStore, ObjectStore, SecretStore } from '@vrrelay/application';
import type { RelayConfig } from '../config.js';

export type ResolvedSecretBackend = 'keychain' | 'dpapi' | 'encrypted-file';

export function resolveSecretBackend(config: RelayConfig): ResolvedSecretBackend {
  if (config.secretBackend !== 'auto') return config.secretBackend;
  if (process.platform === 'darwin') return 'keychain';
  if (process.platform === 'win32') return 'dpapi';
  return 'encrypted-file';
}

export function createSecretStore(
  config: RelayConfig,
  backend: ResolvedSecretBackend
): SecretStore {
  if (backend === 'keychain') return new MacKeychainSecretStore();
  if (backend === 'dpapi')
    return new WindowsDpapiSecretStore(join(config.dataDir, 'secrets.dpapi.json'));
  if (!config.masterKey)
    throw new Error('VRRELAY_MASTER_KEY is required for encrypted-file secrets');
  return new EncryptedFileSecretStore(join(config.dataDir, 'secrets.json'), config.masterKey);
}

export function createCoordinationStore(config: RelayConfig): CoordinationStore {
  if (config.coordinationDriver === 'valkey') {
    if (!config.valkeyUrl) throw new Error('VRRELAY_VALKEY_URL is required for Valkey');
    return new RedisCoordinationStore(config.valkeyUrl);
  }
  return new MemoryCoordinationStore();
}

export function createBootstrapObjectStores(config: RelayConfig): {
  local: LocalObjectStore;
  configured: ObjectStore;
} {
  const local = new LocalObjectStore(config.objectStorePath ?? join(config.dataDir, 'objects'));
  switch (config.objectStoreDriver) {
    case 's3':
      if (!config.objectStoreBucket)
        throw new Error('VRRELAY_OBJECT_STORE_BUCKET is required for S3');
      return {
        local,
        configured: new S3ObjectStore({
          bucket: config.objectStoreBucket,
          region: config.s3Region,
          prefix: config.objectStorePrefix,
          ...(config.s3Endpoint ? { endpoint: config.s3Endpoint } : {}),
          ...(config.s3AccessKeyId ? { accessKeyId: config.s3AccessKeyId } : {}),
          ...(config.s3SecretAccessKey ? { secretAccessKey: config.s3SecretAccessKey } : {})
        })
      };
    case 'azure-blob':
      if (!config.azureAccountUrl)
        throw new Error('VRRELAY_AZURE_ACCOUNT_URL is required for Azure Blob');
      if (!config.objectStoreBucket)
        throw new Error('VRRELAY_OBJECT_STORE_BUCKET is required for Azure Blob');
      return {
        local,
        configured: new AzureBlobObjectStore({
          accountUrl: config.azureAccountUrl,
          container: config.objectStoreBucket,
          prefix: config.objectStorePrefix,
          ...(config.azureAccountName ? { accountName: config.azureAccountName } : {}),
          ...(config.azureAccountKey ? { accountKey: config.azureAccountKey } : {})
        })
      };
    case 'gcs':
      if (!config.objectStoreBucket)
        throw new Error('VRRELAY_OBJECT_STORE_BUCKET is required for GCS');
      return {
        local,
        configured: new GcsObjectStore({
          bucket: config.objectStoreBucket,
          prefix: config.objectStorePrefix,
          ...(config.gcsProjectId ? { projectId: config.gcsProjectId } : {}),
          ...(config.gcsKeyFilename ? { keyFilename: config.gcsKeyFilename } : {})
        })
      };
    default:
      return { local, configured: local };
  }
}
