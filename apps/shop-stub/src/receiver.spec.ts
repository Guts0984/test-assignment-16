import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { signWebhook } from '@ff/shared/rules/webhook';
import { receiveWebhook } from './receiver';
import { createStore } from './store';

const now = new Date('2026-11-24T10:00:00Z');
const ts = Math.floor(now.getTime() / 1000);
const calm = { enabled: false, cancelRate: 0, failEvery: 5, timeoutHoldMs: 0 };
const envelope = (version: number, stream = `stock:${'0'.repeat(8)}-0000-4000-8000-000000000001`) =>
  JSON.stringify({ eventId: randomUUID(), type: 'stock.available_changed', stream, version, occurredAt: now.toISOString(), data: { available: version } });

const setup = () => {
  const store = createStore();
  store.registerShop({ code: 'S1', apiKey: 'k', webhookSecret: 'secret' });
  const send = (body: string, headers: Record<string, string> = {}, chaos = calm) =>
    receiveWebhook(store, chaos, 'S1', body, { 'x-fulfillment-signature': signWebhook('secret', body, ts), ...headers }, now, 300);
  return { store, send };
};

describe('webhook receiver', () => {
  it('accepts a valid signed event', () => {
    const { store, send } = setup();
    expect(send(envelope(1)).status).toBe(200);
    expect(store.received()[0]?.outcome).toBe('accepted');
  });
  it('rejects tampered body, wrong secret, stale timestamp and unknown shop', () => {
    const { store, send } = setup();
    const body = envelope(1);
    const sig = signWebhook('secret', body, ts);
    expect(receiveWebhook(store, calm, 'S1', `${body} `, { 'x-fulfillment-signature': sig }, now, 300).status).toBe(401);
    expect(receiveWebhook(store, calm, 'S1', body, { 'x-fulfillment-signature': signWebhook('other', body, ts) }, now, 300).status).toBe(401);
    expect(receiveWebhook(store, calm, 'S1', body, { 'x-fulfillment-signature': signWebhook('secret', body, ts - 301) }, now, 300).status).toBe(401);
    expect(receiveWebhook(store, calm, 'NOPE', body, {}, now, 300).status).toBe(404);
    expect(send('not json').status).toBe(400);
    expect(store.received().filter((r) => r.outcome === 'accepted')).toHaveLength(0);
  });
  it('drops older or equal versions and duplicates (replay)', () => {
    const { store, send } = setup();
    const v2 = envelope(2);
    send(v2);
    send(envelope(1));
    send(v2);
    send(envelope(3));
    expect(store.received().map((r) => r.outcome)).toEqual(['accepted', 'stale_version', 'duplicate', 'accepted']);
    expect(store.latest('S1')[0]).toMatchObject({ version: 3, data: { available: 3 } });
  });
  it('chaos: the fifth delivery gets 500 and is not accepted', () => {
    const { store, send } = setup();
    const statuses = Array.from({ length: 10 }, (_, i) => send(envelope(i + 1), {}, { ...calm, enabled: true }));
    expect(statuses.map((s) => s.status)).toEqual([200, 200, 200, 200, 500, 200, 200, 200, 200, 504]);
    expect(statuses[9]?.holdMs).toBe(0);
    expect(store.received().filter((r) => r.outcome === 'accepted')).toHaveLength(8);
  });
  it('an event id header that disagrees with the body is rejected', () => {
    const { send } = setup();
    expect(send(envelope(1), { 'x-fulfillment-event-id': randomUUID() }).status).toBe(400);
  });
});
