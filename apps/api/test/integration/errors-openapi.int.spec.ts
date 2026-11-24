// Error format on every failure path, route guard defaults, OpenAPI completeness, test clock gating.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildOpenApi } from '../../src/bootstrap';
import { http, startTestApp, type TestApp } from '../setup/app';
import { makeAdmin, makeShop, makeStaff } from '../setup/fixtures';

let t: TestApp;
let api: ReturnType<typeof http>;
let admin: string;
beforeAll(async () => {
  t = await startTestApp({ RATE_LIMIT_ENABLED: 'false', BODY_LIMIT_BYTES: '2048' });
  api = http(t.base);
  admin = await makeAdmin(t.db, api);
});
afterAll(async () => t.close());

const isErrorBody = (b: { error?: { code?: unknown; message?: unknown; requestId?: unknown } }) =>
  typeof b.error?.code === 'string' && typeof b.error.message === 'string' && typeof b.error.requestId === 'string';

describe('error format', () => {
  it.each([
    ['malformed JSON', () => api.post('/api/auth/login', undefined, { raw: '{"email":' }), 400, 'MALFORMED_JSON'],
    ['proto pollution', () => api.post('/api/auth/login', undefined, { raw: '{"__proto__":{"admin":true},"email":"a@b.cd","password":"x"}' }), 400, 'MALFORMED_JSON'],
    ['oversized body', () => api.post('/api/auth/login', { email: 'a@b.cd', password: 'x'.repeat(5000) }), 413, 'PAYLOAD_TOO_LARGE'],
    ['wrong content type', () => api.post('/api/auth/login', undefined, { raw: 'email=a', headers: { 'content-type': 'application/x-www-form-urlencoded' } }), 415, 'UNSUPPORTED_MEDIA_TYPE'],
    ['unknown route', () => api.get('/api/nope'), 404, 'NOT_FOUND'],
    ['non-uuid id', () => api.get('/api/admin/shops/not-a-uuid/api-keys', { token: admin }), 400, 'VALIDATION_FAILED'],
    ['null byte in text', () => api.post('/api/admin/staff', { email: 'x@y.zz', name: 'a\u0000b', password: '12345678' }, { token: admin }), 400, 'VALIDATION_FAILED'],
    ['huge array', () => api.post('/api/admin/staff', { email: 'x@y.zz', name: 'n', password: '12345678', roles: Array.from({ length: 300 }, () => ({ role: 'picker', warehouseId: null })) }, { token: admin }), 413, 'PAYLOAD_TOO_LARGE'],
  ])('%s -> %i %s in the shared format', async (_n, call, status, code) => {
    const r = await call();
    expect(r.status).toBe(status);
    expect(r.body.error.code).toBe(code);
    expect(isErrorBody(r.body)).toBe(true);
    expect(JSON.stringify(r.body)).not.toMatch(/prisma|SELECT|at \w+ \(|node_modules/i);
  });
});

describe('route guards', () => {
  it('every protected operation answers 401 without credentials and the shared error body', async () => {
    const doc = buildOpenApi(t.app);
    const publicOps = new Set(['post /api/auth/login', 'post /api/auth/refresh', 'post /api/auth/logout', 'get /api/time', 'get /api/health']);
    const ops = Object.entries(doc.paths).flatMap(([p, item]) =>
      Object.keys(item).filter((m) => ['get', 'post', 'patch', 'put', 'delete'].includes(m)).map((m) => [m, p] as const),
    );
    expect(ops.length).toBeGreaterThan(20);
    for (const [m, p] of ops) {
      if (publicOps.has(`${m} ${p}`)) continue;
      const path = p.replace(/\{[^}]+\}/g, '00000000-0000-4000-8000-000000000000');
      const r = await api.call(m.toUpperCase(), path, m === 'get' ? {} : { body: {} });
      expect([`${m} ${p}`, r.status]).toEqual([`${m} ${p}`, 401]);
      expect(isErrorBody(r.body)).toBe(true);
    }
  });

  it('a shop key gets 403 on staff/admin routes; a picker gets 403 on admin routes', async () => {
    const s = await makeShop(api, admin);
    const picker = await makeStaff(api, admin, []);
    expect((await api.get('/api/admin/shops', { token: s.apiKey })).status).toBe(403);
    expect((await api.get('/api/orders', { token: s.apiKey })).status).toBe(403);
    expect((await api.get('/api/admin/shops', { token: picker.token })).status).toBe(403);
    expect((await api.get('/api/shop/v1/skus', { token: picker.token })).status).toBe(403);
  });
});

describe('OpenAPI', () => {
  it('every operation declares the shared error body for 400, 429 and 500', () => {
    const doc = buildOpenApi(t.app);
    for (const [p, item] of Object.entries(doc.paths)) {
      for (const [m, op] of Object.entries(item as Record<string, { responses?: Record<string, { content?: unknown }> }>)) {
        if (!['get', 'post', 'patch', 'put', 'delete'].includes(m)) continue;
        for (const code of ['400', '429', '500']) {
          expect(JSON.stringify(op.responses?.[code]?.content ?? ''), `${m} ${p} ${code}`).toContain('ErrorBodyDto');
        }
      }
    }
  });

  it('serves Swagger UI at /docs', async () => {
    const r = await fetch(`${t.base}/docs`);
    expect(r.status).toBe(200);
  });
});

describe('test clock', () => {
  it('does not exist unless enabled', async () => {
    expect((await api.post('/api/test/clock', { advanceMs: 1 })).status).toBe(404);
  });

  it('when enabled, needs the token and moves /time on the same instance', async () => {
    const t2 = await startTestApp({ RATE_LIMIT_ENABLED: 'false', TEST_CLOCK_ENABLED: 'true', TEST_CONTROL_TOKEN: 'test-control-token-123' });
    try {
      const a2 = http(t2.base);
      expect((await a2.post('/api/test/clock', { advanceMs: 1000 })).status).toBe(403);
      expect((await a2.post('/api/test/clock', { advanceMs: 1000 }, { headers: { 'x-test-token': 'wrong-token-value-xx' } })).status).toBe(403);
      const before = Date.parse((await a2.get('/api/time')).body.now);
      const set = await a2.post('/api/test/clock', { advanceMs: 3_600_000 }, { headers: { 'x-test-token': 'test-control-token-123' } });
      expect(set.status).toBe(200);
      expect(Date.parse((await a2.get('/api/time')).body.now) - before).toBeGreaterThan(3_599_000);
      await a2.post('/api/test/clock', { reset: true }, { headers: { 'x-test-token': 'test-control-token-123' } });
    } finally {
      await t2.close();
    }
  });
});
