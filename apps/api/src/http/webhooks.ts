import type { FastifyInstance } from 'fastify';
import { config } from '../config.js';
import { tx } from '../db/pool.js';
import { applyProviderEvent } from '../services/billing.js';
import { verifyStripeSignature } from '../services/payments.js';

/** Webhooks från betalleverantören. Kräver oförändrad råkropp för signaturkontrollen, därför eget inkapslat plugin. Ingen cookie/CSRF – autentisering sker enbart via signaturen. */
export async function webhookRoutes(app: FastifyInstance): Promise<void> {
  app.addContentTypeParser('application/json', { parseAs: 'buffer', bodyLimit: 1_000_000 }, (_req, body, done) => done(null, body));
  app.post('/stripe', async (req, reply) => {
    const ev = verifyStripeSignature(req.body as Buffer, req.headers['stripe-signature'] as string | undefined, config.stripe.webhookSecret);
    const r = await tx((c) => applyProviderEvent(c, ev));
    return reply.code(200).send({ received: true, outcome: r.outcome });
  });
}
