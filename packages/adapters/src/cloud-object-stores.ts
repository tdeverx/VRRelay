// SPDX-License-Identifier: GPL-3.0-or-later
import { Readable } from 'node:stream';
import { BlobServiceClient, StorageSharedKeyCredential } from '@azure/storage-blob';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client
} from '@aws-sdk/client-s3';
import { Storage } from '@google-cloud/storage';
import type { BackendStatus, CachedObject } from '@vrrelay/domain';
import type { ObjectStore, ObjectStorePutOptions } from '@vrrelay/application';

function now() {
  return new Date().toISOString();
}
function status(kind: BackendStatus['kind'], healthy: boolean, message?: string): BackendStatus {
  return {
    category: 'object-store',
    kind,
    healthy,
    ...(message ? { message } : {}),
    checkedAt: now()
  };
}
function metadata(
  key: string,
  size: number,
  contentType: string,
  etag?: string,
  sha256?: string,
  expiresAt?: string | null,
  createdAt?: string
): CachedObject {
  return {
    key,
    size,
    contentType,
    ...(etag ? { etag } : {}),
    ...(sha256 ? { sha256 } : {}),
    expiresAt: expiresAt ?? null,
    createdAt: createdAt ?? now(),
    lastAccessedAt: now()
  };
}

export interface S3ObjectStoreOptions {
  bucket: string;
  region?: string;
  endpoint?: string;
  forcePathStyle?: boolean;
  accessKeyId?: string;
  secretAccessKey?: string;
  prefix?: string;
}

export class S3ObjectStore implements ObjectStore {
  readonly kind = 's3';
  readonly #client: S3Client;
  readonly #prefix: string;

  constructor(private readonly options: S3ObjectStoreOptions) {
    this.#prefix = options.prefix?.replace(/^\/+|\/+$/g, '') ?? 'vrrelay';
    this.#client = new S3Client({
      region: options.region ?? 'us-east-1',
      ...(options.endpoint ? { endpoint: options.endpoint } : {}),
      forcePathStyle: options.forcePathStyle ?? Boolean(options.endpoint),
      ...(options.accessKeyId && options.secretAccessKey
        ? {
            credentials: {
              accessKeyId: options.accessKeyId,
              secretAccessKey: options.secretAccessKey
            }
          }
        : {})
    });
  }

  async put(key: string, source: Readable, options: ObjectStorePutOptions): Promise<CachedObject> {
    const result = await this.#client.send(
      new PutObjectCommand({
        Bucket: this.options.bucket,
        Key: this.#key(key),
        Body: source,
        ContentType: options.contentType,
        Metadata: {
          ...options.metadata,
          'vrrelay-key': key,
          ...(options.sha256 ? { 'vrrelay-sha256': options.sha256 } : {}),
          ...(options.expiresAt ? { 'vrrelay-expires': options.expiresAt } : {})
        }
      })
    );
    return metadata(key, 0, options.contentType, result.ETag, options.sha256, options.expiresAt);
  }

  async stat(key: string): Promise<CachedObject | undefined> {
    try {
      const result = await this.#client.send(
        new HeadObjectCommand({ Bucket: this.options.bucket, Key: this.#key(key) })
      );
      const expiresAt = result.Metadata?.['vrrelay-expires'] ?? null;
      if (expiresAt && Date.parse(expiresAt) <= Date.now()) {
        // Read-only edge credentials are intentionally unable to delete. The
        // backend lifecycle policy remains responsible for eventual removal.
        await this.delete(key).catch(() => undefined);
        return undefined;
      }
      return metadata(
        key,
        result.ContentLength ?? 0,
        result.ContentType ?? 'application/octet-stream',
        result.ETag,
        result.Metadata?.['vrrelay-sha256'],
        expiresAt,
        result.LastModified?.toISOString()
      );
    } catch (error) {
      if ((error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode === 404)
        return undefined;
      throw error;
    }
  }

  async open(key: string): Promise<Readable | undefined> {
    try {
      const result = await this.#client.send(
        new GetObjectCommand({ Bucket: this.options.bucket, Key: this.#key(key) })
      );
      if (!result.Body) return undefined;
      return result.Body as Readable;
    } catch (error) {
      if ((error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode === 404)
        return undefined;
      throw error;
    }
  }

  async delete(key: string): Promise<void> {
    await this.#client.send(
      new DeleteObjectCommand({ Bucket: this.options.bucket, Key: this.#key(key) })
    );
  }

  async health(): Promise<BackendStatus> {
    try {
      await this.#client.send(
        new HeadObjectCommand({ Bucket: this.options.bucket, Key: `${this.#prefix}/.health` })
      );
    } catch (error) {
      const code = (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
      if (code !== 404)
        return status('s3', false, error instanceof Error ? error.message : String(error));
    }
    return status('s3', true);
  }

  #key(key: string) {
    return `${this.#prefix}/${key}`;
  }
}

export interface AzureBlobObjectStoreOptions {
  accountUrl: string;
  container: string;
  accountName?: string;
  accountKey?: string;
  prefix?: string;
}

export class AzureBlobObjectStore implements ObjectStore {
  readonly kind = 'azure-blob';
  readonly #container;
  readonly #prefix: string;

  constructor(private readonly options: AzureBlobObjectStoreOptions) {
    const credential =
      options.accountName && options.accountKey
        ? new StorageSharedKeyCredential(options.accountName, options.accountKey)
        : undefined;
    this.#container = new BlobServiceClient(options.accountUrl, credential).getContainerClient(
      options.container
    );
    this.#prefix = options.prefix?.replace(/^\/+|\/+$/g, '') ?? 'vrrelay';
  }

  async put(key: string, source: Readable, options: ObjectStorePutOptions): Promise<CachedObject> {
    const blob = this.#container.getBlockBlobClient(this.#key(key));
    const result = await blob.uploadStream(source, 4 * 1024 * 1024, 4, {
      blobHTTPHeaders: { blobContentType: options.contentType },
      metadata: {
        ...options.metadata,
        vrrelaykey: key,
        ...(options.sha256 ? { vrrelaysha256: options.sha256 } : {}),
        ...(options.expiresAt ? { vrrelayexpires: options.expiresAt } : {})
      }
    });
    const properties = await blob.getProperties();
    return metadata(
      key,
      properties.contentLength ?? 0,
      options.contentType,
      result.etag,
      options.sha256,
      options.expiresAt
    );
  }

  async stat(key: string): Promise<CachedObject | undefined> {
    const blob = this.#container.getBlobClient(this.#key(key));
    try {
      const properties = await blob.getProperties();
      const expiresAt = properties.metadata?.vrrelayexpires ?? null;
      if (expiresAt && Date.parse(expiresAt) <= Date.now()) {
        await blob.deleteIfExists().catch(() => undefined);
        return undefined;
      }
      return metadata(
        key,
        properties.contentLength ?? 0,
        properties.contentType ?? 'application/octet-stream',
        properties.etag,
        properties.metadata?.vrrelaysha256,
        expiresAt,
        properties.createdOn?.toISOString()
      );
    } catch (error) {
      if ((error as { statusCode?: number }).statusCode === 404) return undefined;
      throw error;
    }
  }

  async open(key: string): Promise<Readable | undefined> {
    try {
      return (
        ((await this.#container.getBlobClient(this.#key(key)).download()).readableStreamBody as
          Readable | undefined) ?? undefined
      );
    } catch (error) {
      if ((error as { statusCode?: number }).statusCode === 404) return undefined;
      throw error;
    }
  }

  async delete(key: string): Promise<void> {
    await this.#container.deleteBlob(this.#key(key), { deleteSnapshots: 'include' });
  }
  async health(): Promise<BackendStatus> {
    try {
      await this.#container.getProperties();
      return status('azure-blob', true);
    } catch (error) {
      return status('azure-blob', false, error instanceof Error ? error.message : String(error));
    }
  }
  #key(key: string) {
    return `${this.#prefix}/${key}`;
  }
}

export interface GcsObjectStoreOptions {
  bucket: string;
  projectId?: string;
  keyFilename?: string;
  credentials?: { client_email: string; private_key: string };
  prefix?: string;
}

export class GcsObjectStore implements ObjectStore {
  readonly kind = 'gcs';
  readonly #bucket;
  readonly #prefix: string;
  constructor(private readonly options: GcsObjectStoreOptions) {
    this.#bucket = new Storage({
      ...(options.projectId ? { projectId: options.projectId } : {}),
      ...(options.keyFilename ? { keyFilename: options.keyFilename } : {}),
      ...(options.credentials ? { credentials: options.credentials } : {})
    }).bucket(options.bucket);
    this.#prefix = options.prefix?.replace(/^\/+|\/+$/g, '') ?? 'vrrelay';
  }
  async put(key: string, source: Readable, options: ObjectStorePutOptions): Promise<CachedObject> {
    const file = this.#bucket.file(this.#key(key));
    await new Promise<void>((resolve, reject) =>
      source
        .pipe(
          file.createWriteStream({
            resumable: false,
            contentType: options.contentType,
            metadata: {
              metadata: {
                ...options.metadata,
                vrrelayKey: key,
                ...(options.sha256 ? { vrrelaySha256: options.sha256 } : {}),
                ...(options.expiresAt ? { vrrelayExpires: options.expiresAt } : {})
              }
            }
          })
        )
        .on('finish', resolve)
        .on('error', reject)
    );
    const [data] = await file.getMetadata();
    return metadata(
      key,
      Number(data.size ?? 0),
      options.contentType,
      data.etag,
      options.sha256,
      options.expiresAt,
      data.timeCreated
    );
  }
  async stat(key: string): Promise<CachedObject | undefined> {
    const file = this.#bucket.file(this.#key(key));
    const [exists] = await file.exists();
    if (!exists) return undefined;
    const [data] = await file.getMetadata();
    const rawExpiresAt = data.metadata?.vrrelayExpires;
    const expiresAt = typeof rawExpiresAt === 'string' ? rawExpiresAt : null;
    if (expiresAt && Date.parse(expiresAt) <= Date.now()) {
      await file.delete({ ignoreNotFound: true }).catch(() => undefined);
      return undefined;
    }
    return metadata(
      key,
      Number(data.size ?? 0),
      typeof data.contentType === 'string' ? data.contentType : 'application/octet-stream',
      typeof data.etag === 'string' ? data.etag : undefined,
      typeof data.metadata?.vrrelaySha256 === 'string' ? data.metadata.vrrelaySha256 : undefined,
      expiresAt,
      typeof data.timeCreated === 'string' ? data.timeCreated : undefined
    );
  }
  async open(key: string): Promise<Readable | undefined> {
    return (await this.stat(key))
      ? this.#bucket.file(this.#key(key)).createReadStream()
      : undefined;
  }
  async delete(key: string): Promise<void> {
    await this.#bucket.file(this.#key(key)).delete({ ignoreNotFound: true });
  }
  async health(): Promise<BackendStatus> {
    try {
      await this.#bucket.getMetadata();
      return status('gcs', true);
    } catch (error) {
      return status('gcs', false, error instanceof Error ? error.message : String(error));
    }
  }
  #key(key: string) {
    return `${this.#prefix}/${key}`;
  }
}
