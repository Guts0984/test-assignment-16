// Failed jobs: visible and rerunnable only by admins, exactly once.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { http, startTestApp, type TestApp } from '../setup/app';
import { makeAdmin, makeStaff, makeShop, uid } from '../setup/fixtures';

let t: TestApp;
beforeAll(async () => {
  t = await startTestApp({ RATE_LIMIT_ENABLED: 'false' });
});
afterAll(async () => t.close());

describe('failed jobs admin', () => {
  it('non-admins cannot list or rerun; an admin reruns a dead job once; a webhook stream revives its dead events', async () => {
    const api = http(t.base);
    const admin = await makeAdmin(t.db, api);
    const lead = await makeStaff(api, admin, []);
    const shop = await makeShop(api, admin);
    const orderId = '11111111-1111-4111-8111-111111111111';
    const stream = `order:${orderId}`;
    const key = `${shop.id}|${stream}`;
    await t.db
      .$executeRaw`INSERT INTO scheduled_actions (kind, key, due_at, status, attempts, last_error) VALUES ('webhook_stream', ${key}, now(), 'dead', 10, 'http 500')`;
    await t.db
      .$executeRaw`INSERT INTO webhook_events (shop_id, stream, version, type, payload, status, next_attempt_at, created_at)
                           VALUES (${shop.id}::uuid, ${stream}, 1, 'order.status_changed', '{}'::jsonb, 'dead', now(), now())`;
    const row = await t.db.scheduledAction.findFirstOrThrow({ where: { kind: 'webhook_stream', key } });
    for (const token of [lead.token, shop.apiKey]) {
      expect((await api.get('/api/admin/jobs/failed', { token })).status).toBe(403);
      expect((await api.post(`/api/admin/jobs/failed/${row.id}/rerun`, undefined, { token })).status).toBe(
        403,
      );
    }
    expect((await api.get('/api/admin/jobs/failed')).status).toBe(401);
    const list = await api.get('/api/admin/jobs/failed', { token: admin });
    expect(list.body.items.find((i: { id: string }) => i.id === row.id)).toMatchObject({
      kind: 'webhook_stream',
      lastError: 'http 500',
      attempts: 10,
    });
    const res = await Promise.all(
      [1, 2, 3].map(() => api.post(`/api/admin/jobs/failed/${row.id}/rerun`, undefined, { token: admin })),
    );
    expect(res.filter((r) => r.status === 200)).toHaveLength(1);
    expect(res.filter((r) => r.status !== 200).every((r) => r.body.error.code === 'JOB_NOT_RERUNNABLE')).toBe(
      true,
    );
    expect((await t.db.scheduledAction.findUniqueOrThrow({ where: { id: row.id } })).status).toBe('pending');
    expect((await t.db.webhookEvent.findFirstOrThrow({ where: { shopId: shop.id } })).status).toBe('pending');
    expect(
      (await api.post(`/api/admin/jobs/failed/${uid('x')}/rerun`, undefined, { token: admin })).status,
    ).toBe(400);
  });
});
