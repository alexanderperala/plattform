import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import { randomUUID } from 'node:crypto';
import { ZodError } from 'zod';
import { config } from '../config.js';
import { pool } from '../db/pool.js';
import { AppError } from '../lib/errors.js';
import { maskDeep, maskString } from '../lib/mask.js';
import { adminRoutes } from './admin/index.js';
import { customerRoutes } from './customer/index.js';
import { webhookRoutes } from './webhooks.js';

export async function recordError(e: {
  requestId?: string; source?: string; workspaceId?: string; userId?: string; adminId?: string;
  method?: string; route?: string; statusCode?: number; code?: string; message: string; details?: unknown;
}): Promise<void> {
  try {
    await pool.query(
      `insert into system_errors (request_id, source, workspace_id, user_id, admin_id, method, route, status_code, code, message, details)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [e.requestId ?? null, e.source ?? 'api', e.workspaceId ?? null, e.userId ?? null, e.adminId ?? null, e.method ?? null,
       e.route ?? null, e.statusCode ?? null, e.code ?? null, maskString(e.message).slice(0, 2000), JSON.stringify(maskDeep(e.details ?? {}))],
    );
  } catch {
    // Felloggning får aldrig orsaka nya fel
  }
}

export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({
    logger: config.isTest ? false : { level: 'info', redact: ['req.headers.cookie', 'req.headers.authorization'] },
    genReqId: () => randomUUID(),
    trustProxy: true,
    bodyLimit: 1_000_000,
  });

  await app.register(cookie);
  app.decorateRequest('errCtx');
  app.addHook('onRequest', async (req, reply) => {
    req.errCtx = {};
    reply.header('x-request-id', req.id);
  });

  app.addHook('onSend', async (req, reply, payload) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'no-referrer');
    reply.header('X-Frame-Options', 'DENY');
    reply.header('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
    if (req.url.startsWith('/api/')) reply.header('Cache-Control', 'no-store');
    return payload;
  });

  app.setErrorHandler(async (err, req, reply) => {
    if (err instanceof ZodError) {
      return reply.status(400).send({
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Indata är ogiltig: ' + err.issues.map((i) => `${i.path.join('.') || 'värde'}: ${i.message}`).join('; '),
          requestId: req.id,
        },
      });
    }
    if (err instanceof AppError) {
      if (err.statusCode >= 500) {
        await recordError({ requestId: req.id, ...req.errCtx, method: req.method, route: req.routeOptions?.url, statusCode: err.statusCode, code: err.code, message: err.message });
      }
      return reply.status(err.statusCode).send({ error: { code: err.code, message: err.message, requestId: req.id, ...(err.details ? { details: err.details } : {}) } });
    }
    const fe = err as { statusCode?: number; code?: string; message?: string };
    if (fe.statusCode && fe.statusCode < 500) {
      return reply.status(fe.statusCode).send({ error: { code: fe.code ?? 'BAD_REQUEST', message: 'Ogiltig förfrågan.', requestId: req.id } });
    }
    req.log.error({ err }, 'Ohanterat fel');
    await recordError({
      requestId: req.id, ...req.errCtx, method: req.method, route: req.routeOptions?.url, statusCode: 500, code: 'INTERNAL',
      message: fe.message ?? 'Okänt fel', details: { name: (err as Error).name },
    });
    return reply.status(500).send({
      error: { code: 'INTERNAL', message: 'Ett internt fel inträffade. Ange felreferensen om du kontaktar support.', requestId: req.id },
    });
  });

  app.setNotFoundHandler((req, reply) =>
    reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'Sökvägen finns inte.', requestId: req.id } }));

  app.get('/healthz', async () => ({ status: 'ok' }));
  app.get('/readyz', async (_req, reply) => {
    try {
      await pool.query('select 1');
      return { status: 'ready' };
    } catch {
      return reply.status(503).send({ status: 'database_unavailable' });
    }
  });

  await app.register(adminRoutes, { prefix: '/api/platform-admin' });
  await app.register(customerRoutes, { prefix: '/api/v1' });
  await app.register(webhookRoutes, { prefix: '/api/webhooks' });
  return app;
}
