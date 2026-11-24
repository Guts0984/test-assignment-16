// Worker test world: direct DB setup (no api), a mutable clock and a real receiver server.
import { createServer, type Server } from 'node:http';
import { type AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import { createDb, type Db } from '@ff/db/client';
import { testEnv } from './setup/test-env';
import { type Clock } from '@ff/core/clock';
import { floorHandlers } from '@ff/core/jobs/handlers';
import { allHandlers, type AllHandlerDeps } from '@ff/core/jobs/handlers';
import { type JobDeps } from '@ff/core/jobs/run-action';
import { nullEmitter } from '@ff/core/realtime';
import { encryptSecret } from '@ff/shared/crypto/secrets';
import { verifyWebhook } from '@ff/shared/rules/webhook';
import { DEFAULT_SETTINGS } from '@ff/core/floor/context';

export const ENC_KEY = Buffer.alloc(32, 9).toString('base64');
export const uid = (p: string): string => `${p}-${randomUUID().slice(0, 8)}`.toUpperCase();

export const testClock = (start = '2026-11-24T10:00:00Z') => {
  const state = { t: Date.parse(start) };
  const clock: Clock = { now: () => new Date(state.t) };
  return {
    clock,
    advance: (ms: number) => void (state.t += ms),
    set: (iso: string) => void (state.t = Date.parse(iso)),
    state,
  };
};
export type TestClock = ReturnType<typeof testClock>;

export const makeDb = (): Db => createDb({ url: testEnv.DATABASE_URL, poolSize: 10 });

export const jobDeps = (
  db: Db,
  clock: Clock,
  over: Partial<AllHandlerDeps> = {},
): JobDeps & AllHandlerDeps => {
  const base = {
    db,
    clock,
    emitter: nullEmitter,
    queues: null,
    settings: { ...DEFAULT_SETTINGS, ...over.settings },
    jobs: {
      leaseMs: 30_000,
      maxAttempts: 5,
      backoffBaseMs: 1000,
      backoffMaxMs: 8000,
      byKind: { webhook_stream: { maxAttempts: 10, backoffBaseMs: 1000, backoffMaxMs: 8000 } },
    },
    nightlyLocalTime: '02:00',
    webhooks: { encKey: ENC_KEY, timeoutMs: 1500, coalesceMs: 5000, allowPrivate: true },
    ...over,
  };
  return { ...base, handlers: allHandlers(base as AllHandlerDeps) } as JobDeps & AllHandlerDeps;
};
export const floorOnly = (d: JobDeps): JobDeps => ({ ...d, handlers: floorHandlers(d) });

export type Received = {
  eventId: string;
  stream: string;
  version: number;
  type: string;
  data: any;
  valid: boolean;
  at: number;
};

/** A real HTTP receiver: verifies signatures, applies the stub's "every Nth fails" chaos. */
export const startReceiver = async (
  secret: string,
  o: { failEvery?: number; holdMs?: number; status?: number } = {},
) => {
  const got: Received[] = [];
  const counter = { n: 0 };
  const server: Server = createServer((req, res) => {
    let body = '';
    req.on('data', (c: Buffer) => (body += c.toString()));
    req.on('end', () => {
      counter.n += 1;
      const sig = verifyWebhook(
        secret,
        body,
        req.headers['x-fulfillment-signature'] as string | undefined,
        Math.floor(Date.now() / 1000),
        300,
      );
      if (o.failEvery !== undefined && counter.n % o.failEvery === 0) {
        res.statusCode = counter.n % (o.failEvery * 2) === 0 ? 504 : 500;
        return setTimeout(() => res.end(), o.holdMs ?? 0);
      }
      if (o.status !== undefined) {
        res.statusCode = o.status;
        return res.end();
      }
      const e = JSON.parse(body) as Received;
      got.push({
        eventId: e.eventId,
        stream: e.stream,
        version: e.version,
        type: e.type,
        data: e.data,
        valid: sig.ok,
        at: Date.now(),
      });
      res.end('{}');
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return {
    got,
    server,
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/hook`,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
};

export const makeShop = async (db: Db, url: string, secret = 'whsec-0123456789abcdef') => {
  const shop = await db.shop.create({
    data: {
      code: uid('S'),
      name: 'Shop',
      webhookUrl: url,
      webhookSecretEnc: encryptSecret(ENC_KEY, secret),
      minShelfLifeDays: 0,
    },
  });
  return { shop, secret };
};

import { insertMovements } from '@ff/db/ledger';
import { withTx } from '@ff/db/tx';
import { newEffects } from '@ff/core/effects';
import { importOrder } from '@ff/core/orders/import';

/** A warehouse with virtual locations and storage cells, one shop with SKUs, stock put straight into cells. */
export const warehouseWorld = async (db: Db, o: { cells?: number; tz?: string } = {}) => {
  const wh = await db.warehouse.create({
    data: {
      code: uid('W'),
      name: 'W',
      country: 'PL',
      timeZone: o.tz ?? 'Europe/Warsaw',
      cutoffLocal: '17:00',
      workingDays: [1, 2, 3, 4, 5],
    },
  });
  await db.location.createMany({
    data: [
      ...(['receiving', 'packing', 'return'] as const).map((kind) => ({
        warehouseId: wh.id,
        kind,
        code: kind.toUpperCase(),
      })),
      ...Array.from({ length: o.cells ?? 4 }, (_, i) => ({
        warehouseId: wh.id,
        kind: 'storage' as const,
        code: `A-${i + 1}`,
        walkOrder: i + 1,
        capacityVolumeCm3: 10_000_000n,
        capacityWeightG: 10_000_000n,
      })),
    ],
  });
  const cells = await db.location.findMany({
    where: { warehouseId: wh.id, kind: 'storage' },
    orderBy: { walkOrder: 'asc' },
  });
  const { shop } = await makeShop(db, 'http://127.0.0.1:9/never');
  const sku = await db.sku.create({
    data: {
      shopId: shop.id,
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
  const batch = await db.batch.create({ data: { skuId: sku.id, code: '-' } });
  const stock = async (cellIndex: number, qty: number) =>
    withTx(db, (tx) =>
      insertMovements(tx, [
        {
          groupId: randomUUID(),
          kind: 'receipt',
          warehouseId: wh.id,
          locationId: cells[cellIndex]?.id ?? '',
          skuId: sku.id,
          batchId: batch.id,
          onHandDelta: qty,
          reservedDelta: 0,
          qty,
          fromLocationId: null,
          toLocationId: cells[cellIndex]?.id ?? '',
          docType: 'test',
          docId: 'stock',
          actorType: 'system',
          actorId: null,
          at: new Date(),
        },
      ]),
    );
  const order = async (clock: Clock, qty = 1, express = false) => {
    const r = await importOrder({ db, clock }, newEffects(), shop.id, {
      externalNumber: uid('ORD'),
      deliveryMethod: express ? 'express' : 'standard',
      address: { name: 'A', line1: 'L', city: 'C', postalCode: '00-001', country: 'PL' },
      lines: [{ sku: sku.code, qty }],
    });
    if (!r.ok) throw new Error(r.error.message);
    return r.value.orderId;
  };
  return { wh, cells, shop, sku, batch, stock, order };
};
