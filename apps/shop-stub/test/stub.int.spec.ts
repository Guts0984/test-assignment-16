// The stub over real HTTP against two fake api copies: chaos sends to both at once, controls
// are hidden without the token, received webhook data is escaped on the page.
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { type AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { signWebhook } from '@ff/shared/rules/webhook';
import { buildStub } from '../src/app';
import { createSender } from '../src/sender';
import { createStore } from '../src/store';

type Hit = { copy: string; method: string; url: string; body: string; at: number };
const hits: Hit[] = [];

const fakeApi = (copy: string): Promise<{ server: Server; url: string }> =>
  new Promise((resolve) => {
    const server = createServer((req: IncomingMessage, res) => {
      let body = '';
      req.on('data', (c: Buffer) => (body += c.toString()));
      req.on('end', () => {
        hits.push({ copy, method: req.method ?? '', url: req.url ?? '', body, at: Date.now() });
        res.setHeader('content-type', 'application/json');
        if (req.url?.startsWith('/api/shop/v1/skus')) return res.end(JSON.stringify({ items: [{ code: 'SKU-A' }, { code: 'SKU-B' }] }));
        res.statusCode = copy === 'a' ? 201 : 200;
        res.end(JSON.stringify({ orderId: '11111111-1111-4111-8111-111111111111', created: copy === 'a', status: 'received' }));
      });
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/api` }));
  });

const TOKEN = 'control-token-0123456789';
let a: { server: Server; url: string };
let b: { server: Server; url: string };
const store = createStore();
const chaos = { enabled: true, cancelRate: 0, failEvery: 5, timeoutHoldMs: 0 };
let base = '';
let close: () => Promise<void>;

beforeAll(async () => {
  a = await fakeApi('a');
  b = await fakeApi('b');
  store.registerShop({ code: 'S1', apiKey: 'fk_00000000_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx', webhookSecret: 'webhook-secret-0123456789' });
  const sender = createSender({ fetch, apiUrl: a.url, apiAUrl: a.url, apiBUrl: b.url, chaos: () => chaos, seed: 1 });
  const app = buildStub({ store, sender, chaos, now: () => new Date(), maxSkewSec: 300, controlToken: TOKEN });
  await app.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  close = async () => {
    await app.close();
    a.server.close();
    b.server.close();
  };
});
afterAll(async () => close());

describe('shop stub', () => {
  it('chaos: one order goes to both api copies at the same moment, same body', async () => {
    const r = await fetch(`${base}/api/send`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ shop: 'S1' }) });
    expect(r.status).toBe(200);
    const orders = hits.filter((h) => h.url === '/api/shop/v1/orders');
    expect(orders.map((h) => h.copy).sort()).toEqual(['a', 'b']);
    expect(orders[0]?.body).toBe(orders[1]?.body);
    expect(Math.abs((orders[0]?.at ?? 0) - (orders[1]?.at ?? 0))).toBeLessThan(200);
  });

  it('controls are 404 without the right token', async () => {
    const no = await fetch(`${base}/control/chaos`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"enabled":false}' });
    const wrong = await fetch(`${base}/control/chaos`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-test-token': 'nope' }, body: '{"enabled":false}' });
    expect([no.status, wrong.status]).toEqual([404, 404]);
    const ok = await fetch(`${base}/control/chaos`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-test-token': TOKEN }, body: '{"failEvery":5}' });
    expect(ok.status).toBe(200);
  });

  it('webhook data is HTML-escaped on the page', async () => {
    const body = JSON.stringify({
      eventId: randomUUID(),
      type: 'order.status_changed',
      stream: `order:${randomUUID()}`,
      version: 1,
      occurredAt: new Date().toISOString(),
      data: { note: '<script>alert(1)</script>' },
    });
    const sig = signWebhook('webhook-secret-0123456789', body, Math.floor(Date.now() / 1000));
    const r = await fetch(`${base}/webhooks/S1`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-fulfillment-signature': sig }, body });
    expect(r.status).toBe(200);
    const html = await (await fetch(`${base}/`)).text();
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('a bad signature is rejected and listed as rejected', async () => {
    const body = JSON.stringify({ eventId: randomUUID(), type: 'order.status_changed', stream: `order:${randomUUID()}`, version: 1, occurredAt: new Date().toISOString(), data: {} });
    const r = await fetch(`${base}/webhooks/S1`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-fulfillment-signature': 't=1,v1=' + '0'.repeat(64) }, body });
    expect(r.status).toBe(401);
    const list = (await (await fetch(`${base}/api/webhooks?shop=S1`)).json()) as { items: { outcome: string; signature: string }[] };
    expect(list.items.some((i) => i.outcome === 'rejected' && i.signature !== 'valid')).toBe(true);
  });
});
