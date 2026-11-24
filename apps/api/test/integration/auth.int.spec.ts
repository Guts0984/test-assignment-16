// Authentication against the real app: generic failures, token attacks, refresh rotation and
// reuse detection, logout, deactivation and role removal take effect immediately.
import jwt from 'jsonwebtoken';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { http, startTestApp, type TestApp } from '../setup/app';
import { login, makeAdmin, makeStaff, makeWarehouse, PASSWORD } from '../setup/fixtures';

let t: TestApp;
let api: ReturnType<typeof http>;
let admin: string;
beforeAll(async () => {
  t = await startTestApp({ RATE_LIMIT_ENABLED: 'false' });
  api = http(t.base);
  admin = await makeAdmin(t.db, api);
});
afterAll(async () => t.close());

describe('login', () => {
  it('wrong password and unknown user fail identically', async () => {
    const s = await makeStaff(api, admin, []);
    const wrong = await api.post('/api/auth/login', { email: s.email, password: 'nope-nope-nope' });
    const unknown = await api.post('/api/auth/login', {
      email: 'ghost@test.local',
      password: 'nope-nope-nope',
    });
    expect([wrong.status, unknown.status]).toEqual([401, 401]);
    expect({ ...wrong.body.error, requestId: 'x' }).toEqual({ ...unknown.body.error, requestId: 'x' });
  });

  it('rejects mass assignment and malformed input with field errors', async () => {
    const r = await api.post('/api/auth/login', { email: 'a@b.c', password: 'x', role: 'admin' });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('VALIDATION_FAILED');
    expect(Array.isArray(r.body.error.fields)).toBe(true);
  });
});

describe('access tokens', () => {
  it('alg none, wrong secret and a forged subject are refused', async () => {
    const s = await makeStaff(api, admin, []);
    const decoded = jwt.decode(s.token) as Record<string, unknown>;
    const none = jwt.sign({ ...decoded, sub: '00000000-0000-4000-8000-000000000000' }, '', {
      algorithm: 'none',
    });
    const wrongSecret = jwt.sign(decoded, 'z'.repeat(48), { algorithm: 'HS256' });
    for (const token of [none, wrongSecret, `${s.token}x`, 'garbage-token-value']) {
      const r = await api.get('/api/auth/me', { token });
      expect(r.status, token.slice(0, 20)).toBe(401);
      expect(['TOKEN_INVALID', 'UNAUTHENTICATED']).toContain(r.body.error.code);
    }
    expect((await api.get('/api/auth/me', { token: s.token })).status).toBe(200);
  });

  it('a deactivated employee is locked out on the next request', async () => {
    const s = await makeStaff(api, admin, []);
    expect((await api.get('/api/auth/me', { token: s.token })).status).toBe(200);
    await api.patch(`/api/admin/staff/${s.id}`, { active: false }, { token: admin });
    expect((await api.get('/api/auth/me', { token: s.token })).status).toBe(401);
    expect((await api.post('/api/auth/login', { email: s.email, password: PASSWORD })).status).toBe(401);
  });

  it('a removed warehouse role takes effect immediately', async () => {
    const w = await makeWarehouse(api, admin, { cells: 0 });
    const s = await makeStaff(api, admin, [{ role: 'storekeeper', warehouseId: w.id }]);
    expect((await api.get(`/api/warehouses/${w.id}/cells`, { token: s.token })).status).toBe(200);
    const patched = await api.patch(`/api/admin/staff/${s.id}`, { roles: [] }, { token: admin });
    expect([patched.status, patched.body.roles]).toEqual([200, []]);
    expect((await api.get(`/api/warehouses/${w.id}/cells`, { token: s.token })).status).toBe(403);
  });
});

describe('refresh tokens', () => {
  it('rotate; reusing an old one revokes the whole family, including the new tokens', async () => {
    const s = await makeStaff(api, admin, []);
    const first = await api.post('/api/auth/login', { email: s.email, password: PASSWORD });
    const r1 = first.body.refreshToken as string;
    const second = await api.post('/api/auth/refresh', { refreshToken: r1 });
    expect(second.status).toBe(200);
    expect(second.body.refreshToken).not.toBe(r1);
    const reuse = await api.post('/api/auth/refresh', { refreshToken: r1 });
    expect([reuse.status, reuse.body.error.code]).toEqual([401, 'TOKEN_REUSED']);
    expect((await api.post('/api/auth/refresh', { refreshToken: second.body.refreshToken })).status).toBe(
      401,
    );
    expect((await api.get('/api/auth/me', { token: second.body.accessToken })).status).toBe(401);
  });

  it('parallel refresh with one token: at most one succeeds', async () => {
    const s = await makeStaff(api, admin, []);
    const r = (await api.post('/api/auth/login', { email: s.email, password: PASSWORD })).body.refreshToken;
    const res = await Promise.all(
      Array.from({ length: 5 }, () => api.post('/api/auth/refresh', { refreshToken: r })),
    );
    expect(res.filter((x) => x.status === 200).length).toBeLessThanOrEqual(1);
    // a lost race is a clean 401, never an unexpected error
    expect(res.every((x) => x.status === 200 || x.status === 401)).toBe(true);
  });

  it('logout revokes refresh and access tokens (no replay after logout)', async () => {
    const s = await makeStaff(api, admin, []);
    const sess = (await api.post('/api/auth/login', { email: s.email, password: PASSWORD })).body;
    expect((await api.post('/api/auth/logout', { refreshToken: sess.refreshToken })).status).toBe(204);
    expect((await api.get('/api/auth/me', { token: sess.accessToken })).status).toBe(401);
    expect((await api.post('/api/auth/refresh', { refreshToken: sess.refreshToken })).status).toBe(401);
  });

  it('sets an httpOnly, SameSite=Strict refresh cookie scoped to /api/auth', async () => {
    const s = await makeStaff(api, admin, []);
    const r = await api.post('/api/auth/login', { email: s.email, password: PASSWORD });
    const cookie = r.headers.get('set-cookie') ?? '';
    expect(cookie).toMatch(/ff_refresh=/);
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Strict/i);
    expect(cookie).toMatch(/Path=\/api\/auth/);
    expect(await login(api, s.email)).toBeTruthy();
  });
});
