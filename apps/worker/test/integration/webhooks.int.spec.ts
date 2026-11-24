// Webhook delivery against a real receiver: every event arrives despite 500s and timeouts, in
// version order, with the latest stock value, once per window, safely under concurrent workers.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Db } from '@ff/db/client';
import { withTx } from '@ff/db/tx';
import { newEffects } from '@ff/core/effects';
import { drainDue, processAction } from '@ff/core/jobs/run-action';
import {
  markStockChanged,
  recordOrderEvent,
  orderStream,
  streamActionKey,
  stockStream,
} from '@ff/core/outbox';
import { isPrivateAddress } from '@ff/core/jobs/webhook-http';
import { ENC_KEY, jobDeps, makeDb, makeShop, startReceiver, testClock, uid } from '../world';
import { randomUUID } from 'node:crypto';

let db: Db;
beforeAll(() => {
  db = makeDb();
});
afterAll(async () => db.$disconnect());

const orderEvents = async (shopId: string, orderId: string, n: number, clock: { now: () => Date }) => {
  for (let v = 1; v <= n; v += 1) {
    await withTx(db, (tx) =>
      recordOrderEvent(tx, newEffects(), {
        shopId,
        orderId,
        externalNumber: 'X',
        status: `s${v}`,
        previousStatus: v > 1 ? `s${v - 1}` : null,
        version: v,
        at: clock.now(),
      }),
    );
  }
};

describe('order status events', () => {
  it('chaos (every 2nd attempt fails with 500/timeout): every event is delivered exactly once, in version order', async () => {
    const rcv = await startReceiver('whsec-0123456789abcdef', { failEvery: 2, holdMs: 50 });
    try {
      const { shop } = await makeShop(db, rcv.url);
      const tc = testClock();
      const d = jobDeps(db, tc.clock, {
        webhooks: {
          encKey: ENC_KEY,
          timeoutMs: 400,
          coalesceMs: 5000,
          allowPrivate: true,
        },
      });
      const orderId = randomUUID();
      await orderEvents(shop.id, orderId, 8, tc.clock);
      const outcomes: string[] = [];
      for (let round = 0; round < 60 && rcv.got.length < 8; round += 1) {
        const due = await db.scheduledAction.findFirst({
          where: { kind: 'webhook_stream', key: streamActionKey(shop.id, orderStream(orderId)) },
        });
        if (due === null) break;
        outcomes.push(await processAction(d, due.id, 'w1'));
        tc.advance(10_000);
      }
      expect(rcv.got.map((g) => g.version)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
      expect(rcv.got.every((g) => g.valid)).toBe(true);
      expect(new Set(rcv.got.map((g) => g.eventId)).size).toBe(8);
      expect(outcomes).toContain('retry');
      expect(
        (await db.webhookEvent.findMany({ where: { shopId: shop.id }, orderBy: { version: 'asc' } })).map(
          (e) => e.status,
        ),
      ).toEqual(Array(8).fill('delivered'));
    } finally {
      await rcv.close();
    }
  });

  it('three workers racing for the same stream deliver each event once', async () => {
    const rcv = await startReceiver('whsec-0123456789abcdef');
    try {
      const { shop } = await makeShop(db, rcv.url);
      const tc = testClock();
      const d = jobDeps(db, tc.clock);
      const orderId = randomUUID();
      await orderEvents(shop.id, orderId, 5, tc.clock);
      const row = await db.scheduledAction.findFirstOrThrow({
        where: { kind: 'webhook_stream', key: streamActionKey(shop.id, orderStream(orderId)) },
      });
      const res = await Promise.all(['a', 'b', 'c'].map((w) => processAction(d, row.id, w)));
      expect(res.filter((r) => r === 'done')).toHaveLength(1);
      expect(rcv.got.map((g) => g.version)).toEqual([1, 2, 3, 4, 5]);
    } finally {
      await rcv.close();
    }
  });

  it('exhausted attempts: the stream is dead, events are marked dead, and a rerun delivers them', async () => {
    const rcv = await startReceiver('whsec-0123456789abcdef', { status: 500 });
    const { shop } = await makeShop(db, rcv.url);
    const tc = testClock();
    const d = jobDeps(db, tc.clock, {
      jobs: {
        leaseMs: 30_000,
        maxAttempts: 3,
        backoffBaseMs: 100,
        backoffMaxMs: 100,
        byKind: { webhook_stream: { maxAttempts: 3, backoffBaseMs: 100, backoffMaxMs: 100 } },
      },
    });
    const orderId = randomUUID();
    await orderEvents(shop.id, orderId, 2, tc.clock);
    const row = await db.scheduledAction.findFirstOrThrow({
      where: { kind: 'webhook_stream', key: streamActionKey(shop.id, orderStream(orderId)) },
    });
    const out: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      out.push(await processAction(d, row.id, 'w'));
      tc.advance(1000);
    }
    expect(out).toEqual(['retry', 'retry', 'dead']);
    expect((await db.scheduledAction.findUniqueOrThrow({ where: { id: row.id } })).status).toBe('dead');
    expect((await db.webhookEvent.findMany({ where: { shopId: shop.id } })).map((e) => e.status)).toEqual([
      'dead',
      'dead',
    ]);
    await rcv.close();
    const ok = await startReceiver('whsec-0123456789abcdef');
    await db.shop.update({ where: { id: shop.id }, data: { webhookUrl: ok.url } });
    const { rerunDeadAction } = await import('@ff/core/scheduled-actions');
    const { reviveDeadEvents } = await import('@ff/core/jobs/webhooks');
    expect(
      await Promise.all([
        rerunDeadAction(db, row.id, tc.clock.now()),
        rerunDeadAction(db, row.id, tc.clock.now()),
      ]),
    ).toEqual(expect.arrayContaining([true, false]));
    await reviveDeadEvents(db, shop.id, orderStream(orderId), tc.clock.now());
    expect(await processAction(d, row.id, 'w')).toBe('done');
    expect(ok.got.map((g) => g.version)).toEqual([1, 2]);
    await ok.close();
  });
});

describe('stock events', () => {
  const makeSku = async (shopId: string) => {
    const sku = await db.sku.create({
      data: {
        shopId,
        code: uid('K'),
        name: 'n',
        barcode: uid('B'),
        weightG: 1,
        lengthMm: 1,
        widthMm: 1,
        heightMm: 1,
        tracksExpiry: false,
      },
    });
    return sku;
  };

  it('coalesces: at most one event per 5 s per SKU, always the latest value; 4.999 s waits, 5.000 s sends', async () => {
    const rcv = await startReceiver('whsec-0123456789abcdef');
    try {
      const { shop } = await makeShop(db, rcv.url);
      const sku = await makeSku(shop.id);
      const tc = testClock();
      const d = jobDeps(db, tc.clock);
      const change = () =>
        withTx(db, (tx) => markStockChanged(tx, newEffects(), [sku.id], tc.clock.now(), 5000));
      const rowOf = () =>
        db.scheduledAction.findFirstOrThrow({
          where: { kind: 'webhook_stream', key: streamActionKey(shop.id, stockStream(sku.id)) },
        });
      await change();
      expect(await processAction(d, (await rowOf()).id, 'w')).toBe('done');
      expect(rcv.got).toHaveLength(1);
      // 20 quick changes within the window
      for (let i = 0; i < 20; i += 1) {
        await change();
        tc.advance(100);
      }
      let row = await rowOf();
      expect(row.dueAt.getTime() - Date.parse('2026-11-24T10:00:00Z')).toBe(5000);
      tc.set('2026-11-24T10:00:04.999Z');
      expect(await processAction(d, row.id, 'w')).toBe('skipped');
      expect(rcv.got).toHaveLength(1);
      tc.set('2026-11-24T10:00:05.000Z');
      expect(await processAction(d, row.id, 'w')).toBe('done');
      expect(rcv.got).toHaveLength(2);
      expect(rcv.got[1]?.version).toBe(2);
      row = await rowOf();
      expect(row.status).toBe('done');
      const sent = (
        await db.webhookEvent.findMany({
          where: { shopId: shop.id, stream: stockStream(sku.id) },
          orderBy: { version: 'asc' },
        })
      ).filter((e) => e.status === 'delivered');
      expect(sent.map((e) => e.version)).toEqual([1, 2]);
    } finally {
      await rcv.close();
    }
  });

  it('a failing send is superseded by a newer value, never delivered after it; versions only grow at the receiver', async () => {
    const rcv = await startReceiver('whsec-0123456789abcdef', { failEvery: 2 });
    try {
      const { shop } = await makeShop(db, rcv.url);
      const sku = await makeSku(shop.id);
      const tc = testClock();
      const d = jobDeps(db, tc.clock);
      const change = () =>
        withTx(db, (tx) => markStockChanged(tx, newEffects(), [sku.id], tc.clock.now(), 5000));
      const row = async () =>
        db.scheduledAction.findFirstOrThrow({
          where: { kind: 'webhook_stream', key: streamActionKey(shop.id, stockStream(sku.id)) },
        });
      await change();
      expect(await processAction(d, (await row()).id, 'w')).toBe('done');
      for (let round = 0; round < 6; round += 1) {
        tc.advance(5000);
        await change();
        await processAction(d, (await row()).id, 'w').catch(() => 'err');
        tc.advance(2000);
        await processAction(d, (await row()).id, 'w').catch(() => 'err');
      }
      const versions = rcv.got.map((g) => g.version);
      expect(versions).toEqual([...versions].sort((a, b) => a - b));
      expect(new Set(versions).size).toBe(versions.length);
      const events = await db.webhookEvent.findMany({
        where: { shopId: shop.id, stream: stockStream(sku.id) },
      });
      expect(events.some((e) => e.status === 'superseded' || e.status === 'pending')).toBe(true);
    } finally {
      await rcv.close();
    }
  });
});

describe('outbound safety', () => {
  it('delivers to a host NAME (DNS lookup path) when private hosts are allowed, and refuses the same name when they are not', async () => {
    const rcv = await startReceiver('whsec-0123456789abcdef');
    try {
      const url = rcv.url.replace('127.0.0.1', 'localhost');
      const tc = testClock();
      const { shop } = await makeShop(db, url);
      const id = async (o: string) => (await db.scheduledAction.findFirstOrThrow({ where: { kind: 'webhook_stream', key: streamActionKey(shop.id, orderStream(o)) } })).id;
      const o1 = randomUUID();
      await orderEvents(shop.id, o1, 1, tc.clock);
      const open = jobDeps(db, tc.clock, { webhooks: { encKey: ENC_KEY, timeoutMs: 1500, coalesceMs: 5000, allowPrivate: true } });
      expect(await processAction(open, await id(o1), 'w')).toBe('done');
      expect(rcv.got).toHaveLength(1);
      const o2 = randomUUID();
      await orderEvents(shop.id, o2, 1, tc.clock);
      const closed = jobDeps(db, tc.clock, { webhooks: { encKey: ENC_KEY, timeoutMs: 1500, coalesceMs: 5000, allowPrivate: false } });
      expect(await processAction(closed, await id(o2), 'w')).toBe('retry');
      expect((await db.webhookEvent.findFirstOrThrow({ where: { shopId: shop.id, stream: orderStream(o2) } })).lastError).toBe('blocked');
    } finally {
      await rcv.close();
    }
  });

  it('private addresses are blocked unless allowed; redirects are not followed; a hanging receiver times out without blocking another shop', async () => {
    expect(
      [
        '127.0.0.1',
        '10.1.2.3',
        '169.254.169.254',
        '172.16.0.1',
        '192.168.1.1',
        '::1',
        '::ffff:10.0.0.1',
      ].every(isPrivateAddress),
    ).toBe(true);
    expect(['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111'].some(isPrivateAddress)).toBe(false);
    const rcv = await startReceiver('whsec-0123456789abcdef', { status: 302 });
    const slow = await startReceiver('whsec-0123456789abcdef', { failEvery: 1, holdMs: 3000 });
    const fast = await startReceiver('whsec-0123456789abcdef');
    try {
      const tc = testClock();
      const blocked = jobDeps(db, tc.clock, {
        webhooks: {
          encKey: ENC_KEY,
          timeoutMs: 400,
          coalesceMs: 5000,
          allowPrivate: false,
        },
      });
      const open = jobDeps(db, tc.clock, {
        webhooks: {
          encKey: ENC_KEY,
          timeoutMs: 400,
          coalesceMs: 5000,
          allowPrivate: true,
        },
      });
      const a = await makeShop(db, rcv.url);
      const s = await makeShop(db, slow.url);
      const f = await makeShop(db, fast.url);
      const oa = randomUUID();
      const os = randomUUID();
      const of = randomUUID();
      await orderEvents(a.shop.id, oa, 1, tc.clock);
      await orderEvents(s.shop.id, os, 1, tc.clock);
      await orderEvents(f.shop.id, of, 1, tc.clock);
      const id = async (shopId: string, o: string) =>
        (
          await db.scheduledAction.findFirstOrThrow({
            where: { kind: 'webhook_stream', key: streamActionKey(shopId, orderStream(o)) },
          })
        ).id;
      expect(await processAction(blocked, await id(a.shop.id, oa), 'w')).toBe('retry');
      expect((await db.webhookEvent.findFirstOrThrow({ where: { shopId: a.shop.id } })).lastError).toBe(
        'blocked',
      );
      tc.advance(60_000);
      expect(await processAction(open, await id(a.shop.id, oa), 'w')).toBe('retry');
      expect((await db.webhookEvent.findFirstOrThrow({ where: { shopId: a.shop.id } })).lastError).toBe(
        'redirect',
      );
      const t0 = Date.now();
      const [slowR, fastR] = await Promise.all([
        processAction(open, await id(s.shop.id, os), 'w'),
        processAction(open, await id(f.shop.id, of), 'w'),
      ]);
      expect(fastR).toBe('done');
      expect(slowR).toBe('retry');
      expect(fast.got).toHaveLength(1);
      expect(Date.now() - t0).toBeLessThan(2500);
    } finally {
      await Promise.all([rcv.close(), slow.close(), fast.close()]);
    }
  });
});

void drainDue;
