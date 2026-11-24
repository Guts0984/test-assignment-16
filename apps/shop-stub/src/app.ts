// The shop stub HTTP app: page, test API (send, cancel, webhooks), receiver, optional controls.
import { timingSafeEqual } from 'node:crypto';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import { z } from 'zod';
import { type ChaosSettings } from './chaos';
import { receiveWebhook } from './receiver';
import { type Sender } from './sender';
import { type Store } from './store';
import { renderPage } from './ui';

export type StubDeps = {
  readonly store: Store;
  readonly sender: Sender;
  readonly chaos: ChaosSettings;
  readonly now: () => Date;
  readonly maxSkewSec: number;
  readonly controlToken: string | null;
};

const sendSchema = z
  .object({
    shop: z.string().min(1).max(32),
    count: z.coerce.number().int().min(1).max(500).default(1),
    express: z.boolean().optional(),
    externalNumber: z
      .string()
      .regex(/^[A-Za-z0-9._#/-]{1,64}$/)
      .optional(),
    lines: z
      .array(z.object({ sku: z.string().min(1).max(64), qty: z.number().int().min(1).max(1000) }).strict())
      .min(1)
      .max(50)
      .optional(),
  })
  .strict();
const chaosSchema = z
  .object({
    enabled: z.boolean().optional(),
    cancelRate: z.number().min(0).max(1).optional(),
    failEvery: z.number().int().min(0).max(1000).optional(),
    timeoutHoldMs: z.number().int().min(0).max(60_000).optional(),
  })
  .strict();
const shopSchema = z
  .object({
    code: z.string().regex(/^[A-Z0-9_-]{1,32}$/),
    apiKey: z.string().min(10).max(100),
    webhookSecret: z.string().min(16).max(200),
  })
  .strict();

export const buildStub = (d: StubDeps): FastifyInstance => {
  const app = Fastify({ logger: false, bodyLimit: 1_048_576 });
  // Webhook signatures cover the raw bytes, so keep JSON bodies as strings.
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => done(null, body));
  app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (_req, body, done) =>
    done(null, body),
  );

  const json = (req: FastifyRequest): unknown => {
    try {
      return typeof req.body === 'string' && req.body.length > 0 ? JSON.parse(req.body) : {};
    } catch {
      return null;
    }
  };
  const controlOk = (req: FastifyRequest): boolean => {
    if (d.controlToken === null) return false;
    const given = Buffer.from(String(req.headers['x-test-token'] ?? ''));
    const expected = Buffer.from(d.controlToken);
    return given.length === expected.length && timingSafeEqual(given, expected);
  };

  app.get('/', async (_req, reply) =>
    reply.type('text/html; charset=utf-8').send(renderPage(d.store, d.chaos.enabled, null)),
  );
  app.get('/health', async () => ({ ok: true }));

  app.post('/ui/send', async (req, reply) => {
    const form = new URLSearchParams(typeof req.body === 'string' ? req.body : '');
    const parsed = sendSchema.safeParse({ shop: form.get('shop') ?? '', count: form.get('count') ?? '1' });
    const shop = parsed.success ? d.store.shop(parsed.data.shop) : undefined;
    const results = shop === undefined || !parsed.success ? [] : await d.sender.send(shop, parsed.data.count);
    const okCount = results.filter((r) =>
      r.responses.some((x) => x.status === 200 || x.status === 201),
    ).length;
    return reply
      .type('text/html; charset=utf-8')
      .send(renderPage(d.store, d.chaos.enabled, `Sent ${okCount} of ${results.length} orders.`));
  });

  app.post('/api/send', async (req, reply) => {
    const parsed = sendSchema.safeParse(json(req));
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues });
    const shop = d.store.shop(parsed.data.shop);
    if (shop === undefined) return reply.code(404).send({ error: 'unknown shop' });
    const { shop: _s, count, ...opts } = parsed.data;
    return { results: await d.sender.send(shop, count, opts) };
  });

  app.post<{ Params: { shop: string; orderId: string } }>(
    '/api/shops/:shop/orders/:orderId/cancel',
    async (req, reply) => {
      const shop = d.store.shop(req.params.shop);
      if (shop === undefined) return reply.code(404).send({ error: 'unknown shop' });
      const r = await d.sender.cancel(shop, req.params.orderId);
      return reply.code(r.status).send(r.json);
    },
  );

  app.get<{ Querystring: { shop?: string; stream?: string } }>('/api/webhooks', async (req) => ({
    items: d.store.received({ shopCode: req.query.shop, stream: req.query.stream }),
    latest: req.query.shop === undefined ? [] : d.store.latest(req.query.shop),
  }));

  app.post<{ Params: { shop: string } }>('/webhooks/:shop', async (req, reply) => {
    const r = receiveWebhook(
      d.store,
      d.chaos,
      req.params.shop,
      typeof req.body === 'string' ? req.body : '',
      req.headers,
      d.now(),
      d.maxSkewSec,
    );
    if (r.holdMs > 0) await new Promise((res) => setTimeout(res, r.holdMs));
    return reply.code(r.status).send({ ok: r.status === 200 });
  });

  app.post('/control/chaos', async (req, reply) => {
    if (!controlOk(req)) return reply.code(404).send({ error: 'not found' });
    const parsed = chaosSchema.safeParse(json(req));
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues });
    Object.assign(
      d.chaos,
      Object.fromEntries(Object.entries(parsed.data).filter(([, v]) => v !== undefined)),
    );
    return { chaos: d.chaos };
  });
  app.post('/control/shops', async (req, reply) => {
    if (!controlOk(req)) return reply.code(404).send({ error: 'not found' });
    const parsed = shopSchema.safeParse(json(req));
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues });
    d.store.registerShop(parsed.data);
    d.sender.forgetSkus(parsed.data.code);
    return { ok: true };
  });
  app.post('/control/reset', async (req, reply) => {
    if (!controlOk(req)) return reply.code(404).send({ error: 'not found' });
    d.store.reset();
    return { ok: true };
  });
  return app;
};
