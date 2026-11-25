// Every route is attacked: missing credentials, wrong principals, hostile bodies and queries,
// transport abuse. The rule: always the shared error format, never a 500 or a leak.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { apiCopy, burst, client, ledger, percentile, raw, slowRequest } from '../harness/attacker';
import { ensureStack, getStack } from '../harness/global';
import {
  key,
  newSku,
  newWorld,
  nextIp,
  placeOrder,
  scan,
  settled,
  startPickingTask,
  stockUp,
  uid,
  type World,
} from '../harness/scenarios';

let w: World;
type Op = { method: string; path: string; tag: string };
let ops: Op[] = [];

beforeAll(async () => {
  await ensureStack();
  w = await newWorld();
  const doc = (await client({ sourceIp: nextIp() }).get('/docs-json')).body as {
    paths: Record<string, Record<string, { tags?: string[] }>>;
  };
  ops = Object.entries(doc.paths).flatMap(([p, item]) =>
    Object.entries(item)
      .filter(([m]) => ['get', 'post', 'patch', 'put', 'delete'].includes(m))
      .map(([m, o]) => ({ method: m.toUpperCase(), path: p, tag: o.tags?.[0] ?? '' })),
  );
});
afterAll(async () => ledger.assertBalanced());

const ZERO = '00000000-0000-4000-8000-000000000000';
const concrete = (path: string): string => path.replace('{warehouseId}', w.wh.id).replace(/\{[^}]+\}/g, ZERO);
const PUBLIC = new Set([
  'POST /api/auth/login',
  'POST /api/auth/refresh',
  'POST /api/auth/logout',
  'GET /api/time',
  'GET /api/health',
  'GET /api/ready',
]);
const isErrorBody = (b: any): boolean =>
  typeof b?.error?.code === 'string' &&
  typeof b.error.message === 'string' &&
  typeof b.error.requestId === 'string';

describe('the route table', () => {
  it('has a meaningful number of operations', () => expect(ops.length).toBeGreaterThan(60));

  it('every protected route answers 401 without credentials, on both api copies and through nginx', async () => {
    for (const o of ops.filter((x) => !PUBLIC.has(`${x.method} ${x.path}`))) {
      for (const c of [
        client({ sourceIp: nextIp() }),
        apiCopy('a', { sourceIp: nextIp() }),
        apiCopy('b', { sourceIp: nextIp() }),
      ]) {
        const r = await c.call(o.method, concrete(o.path), o.method === 'GET' ? {} : { body: {} });
        expect([`${o.method} ${o.path}`, r.status]).toEqual([`${o.method} ${o.path}`, 401]);
        expect(isErrorBody(r.body)).toBe(true);
      }
    }
  });

  it('wrong kind of caller gets 403: a shop key on staff and admin routes, a staff token on shop routes, a picker on admin routes', async () => {
    const shop = client({ sourceIp: nextIp(), auth: w.shop.apiKey });
    const picker = client({ sourceIp: nextIp(), auth: w.picker1.token });
    for (const o of ops) {
      if (PUBLIC.has(`${o.method} ${o.path}`)) continue;
      const body = o.method === 'GET' ? {} : { body: {} };
      if (!o.path.startsWith('/api/shop/v1') && !['/api/auth/me'].includes(o.path)) {
        expect([`${o.method} ${o.path}`, (await shop.call(o.method, concrete(o.path), body)).status]).toEqual(
          [`${o.method} ${o.path}`, 403],
        );
      }
      if (o.path.startsWith('/api/shop/v1')) {
        expect([
          `${o.method} ${o.path}`,
          (await picker.call(o.method, concrete(o.path), body)).status,
        ]).toEqual([`${o.method} ${o.path}`, 403]);
      }
      if (o.path.startsWith('/api/admin')) {
        expect([
          `${o.method} ${o.path}`,
          (await picker.call(o.method, concrete(o.path), body)).status,
        ]).toEqual([`${o.method} ${o.path}`, 403]);
      }
    }
  });

  it('hostile bodies on every write route never produce a 500 or leak internals', async () => {
    const deep = (n: number): string => '{"a":'.repeat(n) + '1' + '}'.repeat(n);
    const payloads: { name: string; raw: string }[] = [
      { name: 'empty object', raw: '{}' },
      { name: 'array', raw: '[]' },
      { name: 'null', raw: 'null' },
      { name: 'string', raw: '"x"' },
      { name: 'number', raw: '1e999' },
      { name: 'proto pollution', raw: '{"__proto__":{"admin":true},"constructor":{"prototype":{"x":1}}}' },
      { name: 'deeply nested', raw: deep(4000) },
      {
        name: 'huge array',
        raw: JSON.stringify({ lines: Array.from({ length: 50_000 }, (_, i) => ({ sku: `S${i}`, qty: 1 })) }),
      },
      {
        name: 'null bytes and unicode tricks',
        raw: JSON.stringify({ name: 'a\u0000b', code: 'é‮', email: 'x@y.zz\r\nbcc:z@z.zz' }),
      },
      {
        name: 'sql injection in fields',
        raw: JSON.stringify({
          code: "'; DROP TABLE orders;--",
          name: "' OR 1=1 --",
          barcode: '1; SELECT pg_sleep(5)',
          q: "%' OR '1'='1",
        }),
      },
      {
        name: 'xss and long strings',
        raw: JSON.stringify({ name: '<script>alert(1)</script>'.repeat(50), reason: 'x'.repeat(100_000) }),
      },
      { name: 'malformed json', raw: '{"a":' },
      {
        name: 'quantity overflow',
        raw: JSON.stringify({
          qty: 2 ** 53,
          lines: [
            { sku: 'x', qty: -1 },
            { sku: 'y', qty: 1.5 },
          ],
        }),
      },
    ];
    const writes = ops.filter((o) => o.method !== 'GET' && !PUBLIC.has(`${o.method} ${o.path}`));
    const admin = client({ sourceIp: nextIp(), auth: w.admin });
    const shop = client({ sourceIp: nextIp(), auth: w.shop.apiKey });
    const bad: string[] = [];
    for (const o of writes) {
      const who = o.path.startsWith('/api/shop/v1') ? shop : admin;
      for (const p of payloads) {
        const r = await who
          .call(o.method, concrete(o.path), { rawBody: p.raw })
          .catch((e: Error) => ({ status: 0, body: e.message, text: e.message, headers: {}, ms: 0 }));
        const code = (r.body as any)?.error?.code;
        if (
          r.status === 0 ||
          r.status >= 500 ||
          code === 'UNEXPECTED' ||
          (r.status >= 400 && !isErrorBody(r.body)) ||
          /prisma|SELECT |node_modules/i.test(r.text)
        )
          bad.push(`${o.method} ${o.path} <- ${p.name}: ${r.status} ${r.text.slice(0, 120)}`);
      }
    }
    expect(bad).toEqual([]);
  });

  it('hostile query strings on every read route: sql, wildcards, sort injection, bad pagination', async () => {
    const queries = [
      "?q=' OR 1=1--",
      '?q=%25&limit=-1',
      '?limit=99999999999',
      '?sort=password',
      '?cursor=%00%00',
      '?from=2026-13-45&to=nope',
      '?status[$ne]=x',
      '?q=' + 'A'.repeat(5000),
      '?warehouseId=not-a-uuid&shopId=%27',
    ];
    const bad: string[] = [];
    for (const o of ops.filter((x) => x.method === 'GET' && !x.path.includes('label'))) {
      const who = o.path.startsWith('/api/shop/v1')
        ? client({ sourceIp: nextIp(), auth: w.shop.apiKey })
        : client({ sourceIp: nextIp(), auth: w.admin });
      for (const q of queries) {
        const r = await who.get(concrete(o.path) + q);
        if (
          r.status >= 500 ||
          (r.status >= 400 && !isErrorBody(r.body)) ||
          /prisma|SELECT |node_modules/i.test(r.text)
        )
          bad.push(`${o.path}${q.slice(0, 30)}: ${r.status} ${r.text.slice(0, 100)}`);
      }
    }
    expect(bad).toEqual([]);
  });
});

describe('domain values', () => {
  it.each([
    ['invalid time zone', { timeZone: 'Mars/Olympus' }],
    ['cutoff 25:00', { cutoffLocal: '25:00' }],
    ['no working days', { workingDays: [] }],
    ['working day 9', { workingDays: [9] }],
    ['bad holiday date', { holidays: ['2026-02-30'] }],
  ])('warehouse with %s is refused with field errors', async (_n, patch) => {
    const r = await w.as.post('/api/admin/warehouses', {
      code: uid('W'),
      name: 'x',
      country: 'PL',
      timeZone: 'Europe/Warsaw',
      cutoffLocal: '17:00',
      workingDays: [1, 2],
      ...patch,
    });
    expect(r.status).toBe(400);
    expect(r.body.error.fields.length).toBeGreaterThan(0);
  });

  it('cell capacity <= 0, past expiry, huge quantity, inverted and oversized report periods are refused', async () => {
    const z = await w.as.get(`/api/warehouses/${w.wh.id}/cells?limit=1`);
    expect(z.status).toBe(200);
    expect(
      (
        await w.as.post(`/api/admin/zones/${ZERO}/cells`, {
          cells: [{ code: 'Q-1', walkOrder: 1, capacityVolumeCm3: 0, capacityWeightG: 1 }],
        })
      ).status,
    ).toBe(400);
    const sku = await newSku(w, true);
    const rc = await w.store.api.post(`/api/warehouses/${w.wh.id}/receipts`, { shopId: w.shop.id });
    const line = (body: object) =>
      w.store.api.post(`/api/warehouses/${w.wh.id}/receipts/${rc.body.id}/lines`, {
        barcode: sku.barcode,
        idempotencyKey: key(),
        ...body,
      });
    expect((await line({ qty: 1, batchCode: 'L', expiresOn: '2020-01-01' })).body.error.code).toBe(
      'EXPIRY_IN_PAST',
    );
    expect((await line({ qty: 2 ** 40, batchCode: 'L', expiresOn: '2099-01-01' })).status).toBe(400);
    expect((await line({ qty: 0, batchCode: 'L', expiresOn: '2099-01-01' })).status).toBe(400);
    expect((await w.lead.api.get('/api/reports/summary?from=2026-03-01&to=2026-01-01')).status).toBe(400);
    expect((await w.lead.api.get('/api/reports/summary?from=2020-01-01&to=2026-01-01')).status).toBe(400);
    expect((await w.lead.api.get('/api/orders?limit=-5')).status).toBe(400);
  });
});

describe('transport and stored content', () => {
  it('an oversized body gets 413 through nginx and straight from an api copy; wrong content types get 415; malformed JSON 400', async () => {
    const big = 'x'.repeat(2 * 1024 * 1024);
    const viaNginx = await client({ sourceIp: nextIp() }).post('/api/auth/login', undefined, {
      rawBody: big,
    });
    expect(viaNginx.status).toBe(413);
    const direct = await apiCopy('b', { sourceIp: nextIp() }).post('/api/auth/login', undefined, {
      rawBody: JSON.stringify({ email: 'a@b.cd', password: big }),
    });
    expect([direct.status, direct.body.error.code]).toEqual([413, 'PAYLOAD_TOO_LARGE']);
    const form = await client({ sourceIp: nextIp() }).post('/api/auth/login', undefined, {
      rawBody: 'email=a',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    });
    expect([form.status, form.body.error.code]).toEqual([415, 'UNSUPPORTED_MEDIA_TYPE']);
    const bad = await client({ sourceIp: nextIp() }).post('/api/auth/login', undefined, { rawBody: '{"a":' });
    expect([bad.status, bad.body.error.code]).toEqual([400, 'MALFORMED_JSON']);
  });

  it('unexpected methods and unknown routes answer in the shared error format', async () => {
    for (const m of ['DELETE', 'PUT', 'OPTIONS', 'PATCH']) {
      const r = await apiCopy('a', { sourceIp: nextIp() }).call(m, '/api/health');
      expect(r.status).toBeGreaterThanOrEqual(200);
      expect(r.status).toBeLessThan(500);
      if (r.status >= 400) expect(isErrorBody(r.body)).toBe(true);
    }
    const r = await client({ sourceIp: nextIp() }).get('/api/nothing/here');
    expect([r.status, r.body.error.code]).toEqual([404, 'NOT_FOUND']);
  });

  it('CRLF in headers cannot inject headers; a huge header does not crash the server', async () => {
    const res = await raw(
      getStack().nginx,
      'GET /api/health HTTP/1.1\r\nHost: x\r\nX-Evil: a\r\nSet-Cookie: injected=1\r\nConnection: close\r\n\r\n',
    );
    expect(res).not.toMatch(/^set-cookie: injected/im);
    const huge = await raw(
      getStack().nginx,
      `GET /api/health HTTP/1.1\r\nHost: x\r\nX-Big: ${'a'.repeat(70_000)}\r\nConnection: close\r\n\r\n`,
    );
    expect(huge).toMatch(/^HTTP\/1\.1 (400|431|414)/);
    // nginx's own refusals use the shared JSON error body, never its HTML page
    expect(huge).toMatch(/"code":"VALIDATION_FAILED"/);
    const longUrl = await raw(
      getStack().nginx,
      `GET /api/health?x=${'a'.repeat(9000)} HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n`,
    );
    expect(longUrl).toMatch(/^HTTP\/1\.1 414/);
    expect(longUrl).toMatch(/"code":"VALIDATION_FAILED"/);
    expect((await client({ sourceIp: nextIp() }).get('/api/health')).status).toBe(200);
  });

  it('CORS: a disallowed origin gets no Access-Control-Allow-Origin, the allowed one does; security headers are present', async () => {
    const c = client({ sourceIp: nextIp() });
    const no = await c.get('/api/health', { headers: { origin: 'http://evil.example' } });
    expect(no.headers['access-control-allow-origin']).toBeUndefined();
    const yes = await c.get('/api/health', { headers: { origin: 'http://allowed.example' } });
    expect(yes.headers['access-control-allow-origin']).toBe('http://allowed.example');
    expect(yes.headers['x-content-type-options']).toBe('nosniff');
    expect(yes.headers['x-powered-by']).toBeUndefined();
    expect(yes.headers['x-request-id']).toBeTruthy();
  });

  it('stored XSS payloads in names, addresses, customers and reasons come back as inert data; the label PDF is safe', async () => {
    const xss = '<img src=x onerror=alert(1)>';
    const sku = await w.shopApi.post('/api/shop/v1/skus', {
      code: uid('X'),
      name: xss,
      barcode: uid('B'),
      weightG: 1,
      lengthMm: 1,
      widthMm: 1,
      heightMm: 1,
      tracksExpiry: false,
    });
    expect(sku.status).toBe(201);
    expect(String(sku.headers['content-type'])).toMatch(/application\/json/);
    expect(sku.headers['x-content-type-options']).toBe('nosniff');
    await stockUp(w, { id: sku.body.id, barcode: sku.body.barcode }, 'A-001', 2);
    const number = `XS-${uid()}`;
    const order = await w.shopApi.post('/api/shop/v1/orders', {
      externalNumber: number,
      deliveryMethod: 'standard',
      address: {
        name: xss,
        line1: '<b>1</b>',
        city: '"><script>1</script>',
        postalCode: '00-001',
        country: 'PL',
      },
      lines: [{ sku: sku.body.code, qty: 1 }],
    });
    expect(order.status, order.text).toBe(201);
    await settled([order.body.orderId]);
    const task = await startPickingTask(w);
    await scan(w, task.id, { lineId: task.lines[0].lineId, cellCode: 'A-001', barcode: sku.body.barcode });
    const pack = await w.packer.api.post(`/api/warehouses/${w.wh.id}/packing`, {
      orderRef: number,
      idempotencyKey: key(),
    });
    expect(pack.status, pack.text).toBe(200);
    const label = await w.shopApi.get(`/api/shop/v1/orders/${order.body.orderId}/label`);
    expect(label.status).toBe(200);
    expect(String(label.headers['content-type'])).toBe('application/pdf');
    expect(String(label.headers['content-disposition'])).toMatch(
      /^attachment; filename="label-[0-9a-f-]{36}\.pdf"$/,
    );
    expect(label.text.startsWith('%PDF')).toBe(true);
    const detail = await w.shopApi.get(`/api/shop/v1/orders/${order.body.orderId}`);
    expect(detail.body.customerName).toBe(xss);
  });
});

describe('resource exhaustion', () => {
  it('slowloris sockets and a burst of keep-alive requests from one address do not slow down another client', async () => {
    const [x, y] = [nextIp(), nextIp()];
    const holders = Array.from({ length: 60 }, () => slowRequest(getStack().nginx, 4000, x));
    await new Promise((r) => setTimeout(r, 300));
    const times = await Promise.all(
      Array.from({ length: 30 }, () =>
        client({ sourceIp: y })
          .get('/api/health')
          .then((r) => (r.status === 200 ? r.ms : 99_999)),
      ),
    );
    expect(percentile(times, 95)).toBeLessThan(1500);
    const flooded = await burst(100, () => client({ sourceIp: x }).get('/api/health'));
    expect(flooded.every((r) => r.status === 200 || r.status === 429 || r.status === 503)).toBe(true);
    await Promise.all(holders);
    expect((await client({ sourceIp: y }).get('/api/health')).status).toBe(200);
  });
});

void placeOrder;
