// SPDX-License-Identifier: GPL-3.0-or-later
import { z } from 'zod';
import { NodeCapabilitySchema } from '@vrrelay/domain';

const StrictNodeCapabilitySchema = NodeCapabilitySchema.strict();

const IdentifierSchema = z.string().min(1).max(200);
const JobIdentifierSchema = z.string().min(1).max(500);
const CsrPemSchema = z
  .string()
  .min(1)
  .max(16 * 1024);

export type AgentJsonValue =
  null | boolean | number | string | AgentJsonValue[] | { [key: string]: AgentJsonValue };

const AgentJsonPrimitiveSchema = z.union([
  z.null(),
  z.boolean(),
  z.number(),
  z.string().max(16 * 1024)
]);

function boundedJsonValueSchema(depth: number): z.ZodType<AgentJsonValue> {
  if (depth <= 0) return AgentJsonPrimitiveSchema;
  const child = boundedJsonValueSchema(depth - 1);
  return z.union([
    AgentJsonPrimitiveSchema,
    z.array(child).max(100),
    z.record(z.string().min(1).max(200), child)
  ]);
}

export const AgentJsonObjectSchema = z.record(
  z.string().min(1).max(200),
  boundedJsonValueSchema(5)
);
export type AgentJsonObject = z.infer<typeof AgentJsonObjectSchema>;

export const AgentSignedCertificateSchema = z
  .object({
    certificatePem: z
      .string()
      .min(1)
      .max(64 * 1024),
    caCertificatePem: z
      .string()
      .min(1)
      .max(64 * 1024),
    expiresAt: z.iso.datetime(),
    serialNumber: z.string().min(1).max(256),
    fingerprintSha256: z.string().regex(/^[a-f0-9]{64}$/)
  })
  .strict();
export type AgentSignedCertificate = z.infer<typeof AgentSignedCertificateSchema>;

export const AgentSuccessPayloadSchema = z
  .object({
    ok: z.literal(true),
    result: AgentJsonObjectSchema.optional()
  })
  .strict();
export type AgentSuccessPayload = z.infer<typeof AgentSuccessPayloadSchema>;

export const AgentErrorPayloadSchema = z
  .object({
    ok: z.literal(false),
    error: z
      .object({
        code: z.string().min(1).max(100),
        message: z.string().min(1).max(2_000),
        retryable: z.boolean().default(false)
      })
      .strict()
  })
  .strict();
export type AgentErrorPayload = z.infer<typeof AgentErrorPayloadSchema>;

const HelloPayloadSchema = z
  .object({
    nodeId: IdentifierSchema,
    capabilities: StrictNodeCapabilitySchema,
    draining: z.boolean()
  })
  .strict();

const CapabilityPayloadSchema = z
  .object({
    capabilities: StrictNodeCapabilitySchema,
    draining: z.boolean()
  })
  .strict();

const JobOfferPayloadSchema = z
  .object({
    jobId: JobIdentifierSchema,
    sessionId: IdentifierSchema,
    contentKey: z.string().min(1).max(2_000),
    segmentIndex: z.number().int().nonnegative()
  })
  .strict();

const JobAcceptedPayloadSchema = z
  .object({ ok: z.literal(true), jobId: JobIdentifierSchema })
  .strict();
const JobRejectedPayloadSchema = z
  .object({
    ok: z.literal(false),
    jobId: JobIdentifierSchema.optional(),
    error: z
      .object({
        code: z.string().min(1).max(100),
        message: z.string().min(1).max(2_000),
        retryable: z.boolean().default(false)
      })
      .strict()
  })
  .strict();
const JobProgressPayloadSchema = z.union([
  z
    .object({
      action: z.literal('ensure'),
      token: z.string().min(1).max(500),
      segmentIndex: z.number().int().nonnegative()
    })
    .strict(),
  z
    .object({
      ok: z.literal(true),
      jobId: JobIdentifierSchema,
      state: z.literal('running')
    })
    .strict()
]);
const JobCompletedPayloadSchema = z
  .object({ ok: z.literal(true), jobId: JobIdentifierSchema })
  .strict();
const JobFailedPayloadSchema = z
  .object({
    ok: z.literal(false),
    jobId: JobIdentifierSchema,
    error: z
      .object({
        code: z.string().min(1).max(100),
        message: z.string().min(1).max(2_000),
        retryable: z.boolean().default(false)
      })
      .strict()
  })
  .strict();
const JobCancelPayloadSchema = z.object({ jobId: JobIdentifierSchema }).strict();

const ProviderBindInputBase = {
  nodeId: IdentifierSchema,
  providerId: IdentifierSchema.optional(),
  type: z.literal('jellyfin'),
  name: z.string().min(1).max(100),
  baseUrl: z.url(),
  allowPublicHttp: z.boolean()
} as const;
const ProviderBindInputSchema = z.discriminatedUnion('authMode', [
  z
    .object({
      ...ProviderBindInputBase,
      authMode: z.literal('user_token'),
      username: z.string().min(1).max(500),
      password: z.string().min(1).max(2_000)
    })
    .strict(),
  z
    .object({
      ...ProviderBindInputBase,
      authMode: z.literal('api_key'),
      apiKey: z.string().min(1).max(2_000)
    })
    .strict()
]);
const ProviderBindCommon = {
  nodeId: IdentifierSchema,
  providerId: IdentifierSchema,
  bindingId: IdentifierSchema,
  input: ProviderBindInputSchema
} as const;
const ProviderBindPayloadSchema = z.discriminatedUnion('creationMode', [
  z
    .object({
      ...ProviderBindCommon,
      creationMode: z.literal('new'),
      expectedProviderRevision: z.null()
    })
    .strict(),
  z
    .object({
      ...ProviderBindCommon,
      creationMode: z.literal('existing'),
      expectedProviderRevision: z.number().int().positive()
    })
    .strict()
]);
const ProviderUnbindPayloadSchema = z.object({ bindingId: IdentifierSchema }).strict();
const ProviderBrowsePayloadSchema = z
  .object({
    providerId: IdentifierSchema,
    query: z
      .object({
        parentId: IdentifierSchema.optional(),
        search: z.string().max(200).optional(),
        kinds: z.array(z.string().min(1).max(100)).max(100),
        limit: z.number().int().min(1).max(200),
        offset: z.number().int().nonnegative()
      })
      .strict()
  })
  .strict();
const ProviderItemPayloadSchema = z
  .object({ providerId: IdentifierSchema, itemId: IdentifierSchema })
  .strict();
const ProviderValidatePayloadSchema = z.object({ providerId: IdentifierSchema }).strict();
const ProviderActivityPayloadSchema = z
  .object({
    providerId: IdentifierSchema,
    sessionId: IdentifierSchema,
    itemId: IdentifierSchema,
    positionTicks: z.number().int().nonnegative(),
    paused: z.boolean(),
    event: z.enum(['start', 'progress', 'stop'])
  })
  .strict();

const EnvelopeBase = {
  version: z.literal(1),
  id: IdentifierSchema,
  sequence: z.number().int().positive(),
  sentAt: z.iso.datetime(),
  replyTo: IdentifierSchema.optional(),
  deadlineAt: z.iso.datetime().optional()
} as const;

function envelope<const Kind extends string, Payload extends z.ZodType>(
  kind: Kind,
  payload: Payload
) {
  return z.object({ ...EnvelopeBase, kind: z.literal(kind), payload }).strict();
}

export const AgentEnvelopeSchema = z.discriminatedUnion('kind', [
  envelope('hello', HelloPayloadSchema),
  envelope('heartbeat', CapabilityPayloadSchema),
  envelope('capabilities', CapabilityPayloadSchema),
  envelope('job.offer', JobOfferPayloadSchema),
  envelope('job.accept', JobAcceptedPayloadSchema),
  envelope('job.reject', JobRejectedPayloadSchema),
  envelope('job.progress', JobProgressPayloadSchema),
  envelope('job.complete', JobCompletedPayloadSchema),
  envelope('job.fail', JobFailedPayloadSchema),
  envelope('job.cancel', JobCancelPayloadSchema),
  envelope('drain', z.object({ draining: z.boolean() }).strict()),
  envelope(
    'certificate.rotate',
    z.union([
      z.object({ reason: z.enum(['administrative', 'scheduled']) }).strict(),
      z.object({ csrPem: CsrPemSchema }).strict()
    ])
  ),
  envelope(
    'certificate.rotated',
    z.object({ ok: z.literal(true), certificate: AgentSignedCertificateSchema }).strict()
  ),
  envelope(
    'log',
    z
      .object({
        level: z.enum(['debug', 'info', 'warn', 'error']),
        message: z.string().min(1).max(2_000),
        context: AgentJsonObjectSchema
      })
      .strict()
  ),
  envelope('response', AgentSuccessPayloadSchema),
  envelope('error', AgentErrorPayloadSchema),
  envelope('provider.bind', ProviderBindPayloadSchema),
  envelope('provider.unbind', ProviderUnbindPayloadSchema),
  envelope('provider.browse', ProviderBrowsePayloadSchema),
  envelope('provider.item', ProviderItemPayloadSchema),
  envelope('provider.validate', ProviderValidatePayloadSchema),
  envelope('provider.activity', ProviderActivityPayloadSchema)
]);

export type AgentEnvelope = z.infer<typeof AgentEnvelopeSchema>;
export type AgentMessageKind = AgentEnvelope['kind'];
export type AgentEnvelopeOf<Kind extends AgentMessageKind> = Extract<AgentEnvelope, { kind: Kind }>;
export type AgentPayload<Kind extends AgentMessageKind> = AgentEnvelopeOf<Kind>['payload'];
