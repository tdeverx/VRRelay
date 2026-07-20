// SPDX-License-Identifier: GPL-3.0-or-later
import Fastify, { type FastifyInstance } from 'fastify';

export interface ListenAddress {
  host: string;
  port: number;
}

export function requiresLoopbackCompanion(host: string): boolean {
  const normalized = host.toLowerCase().replace(/^\[|\]$/g, '');
  return !['0.0.0.0', '::', '127.0.0.1', 'localhost'].includes(normalized);
}

export async function startLoopbackCompanion(
  listen: ListenAddress,
  register: (app: FastifyInstance) => void
): Promise<FastifyInstance | undefined> {
  if (!requiresLoopbackCompanion(listen.host)) return undefined;
  const app = Fastify({ logger: false, bodyLimit: 1_048_576 });
  register(app);
  await app.listen({ host: '127.0.0.1', port: listen.port });
  return app;
}
