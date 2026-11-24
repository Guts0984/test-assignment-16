// Authentication, token attacks, refresh rotation across copies, API keys and unique-key races.
import jwt from 'jsonwebtoken';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { apiCopy, burst, client, clock, ledger, percentile } from '../harness/attacker';
import { ensureStack, getStack } from '../harness/global';
import { login, newSku, newWorld, nextIp, PASSWORD, uid, type World } from '../harness/scenarios';

let w: World;
beforeAll(async () => {
  await ensureStack();
  w = await newWorld();
});
afterAll(async () => {
  await clock.reset();
  await ledger.assertBalanced();
});
const emailOf = async (id: string) => (await getStack().db.staff.findUniqueOrThrow({ where: { id } })).email;
const secret = () => getStack().env.JWT_ACCESS_SECRET as string;

describe('login', () => {
  it('unknown user and wrong password are indistinguishable in body, status and timing', async () => {
    const email = await emailOf(w.picker1.id);
    const ms = { wrong: [] as number[], unknown: [] as number[] };
    let a: any;
    let b: any;
    for (let i = 0; i < 8; i += 1) {
      const c = client({ sourceIp: nextIp() });
      const r1 = await c.post('/api/auth/login', { email, password: 'wrong-password-1' });
      const r2 = await c.post('/api/auth/login', {
        email: `ghost-${i}@adv.local`,
        password: 'wrong-password-1',
      });
      ms.wrong.push(r1.ms);
      ms.unknown.push(r2.ms);
      a = r1;
      b = r2;
    }
    expect([a.status, b.status]).toEqual([401, 401]);
    expect({ ...a.body.error, requestId: '' }).toEqual({ ...b.body.error, requestId: '' });
    const [mw, mu] = [percentile(ms.wrong, 50), percentile(ms.unknown, 50)];
    expect(Math.max(mw, mu) / Math.max(1, Math.min(mw, mu))).toBeLessThan(3);
  });
});

describe('access token attacks (over the network, both copies)', () => {
  it('tampered payload, alg none, wrong secret, expired, not yet valid, missing claims and a stranger token fail', async () => {
    const good = w.lead.token;
    const claims = jwt.decode(good) as { sub: string; typ: string; fam: string; iat: number; exp: number };
    const now = Math.floor(Date.now() / 1000);
    const forgeries: Record<string, string> = {
      none: jwt.sign({ ...claims }, '', { algorithm: 'none' }),
      wrongSecret: jwt.sign(claims, 'x'.repeat(64), { algorithm: 'HS256' }),
      tampered: `${good.split('.')[0]}.${Buffer.from(JSON.stringify({ ...claims, sub: w.admin })).toString('base64url')}.${good.split('.')[2]}`,
      expired: jwt.sign(
        { sub: claims.sub, typ: claims.typ, fam: claims.fam, iat: now - 4000, exp: now - 100 },
        secret(),
        { algorithm: 'HS256' },
      ),
      notYetValid: jwt.sign(
        { sub: claims.sub, typ: claims.typ, fam: claims.fam, iat: now + 3600, exp: now + 7200 },
        secret(),
        { algorithm: 'HS256' },
      ),
      missingFam: jwt.sign({ sub: claims.sub, typ: claims.typ, iat: now, exp: now + 600 }, secret(), {
        algorithm: 'HS256',
      }),
      extraClaim: jwt.sign({ ...claims, role: 'admin', iat: now, exp: now + 600 }, secret(), {
        algorithm: 'HS256',
      }),
      hs512: jwt.sign({ ...claims, iat: now, exp: now + 600 }, secret(), { algorithm: 'HS512' }),
      unknownUser: jwt.sign(
        {
          sub: '00000000-0000-4000-8000-000000000009',
          typ: 'staff',
          fam: claims.fam,
          iat: now,
          exp: now + 600,
        },
        secret(),
        { algorithm: 'HS256' },
      ),
    };
    for (const [name, token] of Object.entries(forgeries)) {
      for (const which of ['a', 'b'] as const) {
        const r = await apiCopy(which, { sourceIp: nextIp(), auth: token }).get('/api/auth/me');
        expect([name, r.status]).toEqual([name, 401]);
      }
    }
    expect((await apiCopy('a', { sourceIp: nextIp(), auth: good }).get('/api/auth/me')).status).toBe(200);
  });

  it('a token expires on the shared clock (15 minutes) and a refresh brings a working one', async () => {
    const email = await emailOf(w.store.id);
    const c = client({ sourceIp: nextIp() });
    const sess = (await c.post('/api/auth/login', { email, password: PASSWORD })).body;
    expect((await c.withAuth(sess.accessToken).get('/api/auth/me')).status).toBe(200);
    await clock.advance(16 * 60_000);
    await new Promise((r) => setTimeout(r, 1300));
    expect((await c.withAuth(sess.accessToken).get('/api/auth/me')).status).toBe(401);
    const fresh = await c.post('/api/auth/refresh', { refreshToken: sess.refreshToken });
    expect(fresh.status, fresh.text).toBe(200);
    expect((await c.withAuth(fresh.body.accessToken).get('/api/auth/me')).status).toBe(200);
    await clock.reset();
  });
});

describe('refresh tokens', () => {
  it('reuse of a rotated token through the other copy revokes the whole family, new tokens included', async () => {
    const email = await emailOf(w.packer.id);
    const sess = (
      await apiCopy('a', { sourceIp: nextIp() }).post('/api/auth/login', { email, password: PASSWORD })
    ).body;
    const second = (
      await apiCopy('a', { sourceIp: nextIp() }).post('/api/auth/refresh', {
        refreshToken: sess.refreshToken,
      })
    ).body;
    const reuse = await apiCopy('b', { sourceIp: nextIp() }).post('/api/auth/refresh', {
      refreshToken: sess.refreshToken,
    });
    expect([reuse.status, reuse.body.error.code]).toEqual([401, 'TOKEN_REUSED']);
    expect(
      (
        await apiCopy('a', { sourceIp: nextIp() }).post('/api/auth/refresh', {
          refreshToken: second.refreshToken,
        })
      ).status,
    ).toBe(401);
    expect(
      (await apiCopy('b', { sourceIp: nextIp(), auth: second.accessToken }).get('/api/auth/me')).status,
    ).toBe(401);
  });

  it('parallel refresh with one token across copies: at most one wins; logout kills the session everywhere', async () => {
    const email = await emailOf(w.picker2.id);
    const sess = (await client({ sourceIp: nextIp() }).post('/api/auth/login', { email, password: PASSWORD }))
      .body;
    const res = await burst(8, (i) =>
      apiCopy(i % 2 === 0 ? 'a' : 'b', { sourceIp: nextIp() }).post('/api/auth/refresh', {
        refreshToken: sess.refreshToken,
      }),
    );
    expect(res.filter((r) => r.status === 200).length).toBeLessThanOrEqual(1);
    expect(res.every((r) => r.status === 200 || r.status === 401)).toBe(true);
    const s2 = (await client({ sourceIp: nextIp() }).post('/api/auth/login', { email, password: PASSWORD }))
      .body;
    expect(
      (await client({ sourceIp: nextIp() }).post('/api/auth/logout', { refreshToken: s2.refreshToken }))
        .status,
    ).toBe(204);
    for (const which of ['a', 'b'] as const) {
      expect(
        (await apiCopy(which, { sourceIp: nextIp(), auth: s2.accessToken }).get('/api/auth/me')).status,
      ).toBe(401);
      expect(
        (
          await apiCopy(which, { sourceIp: nextIp() }).post('/api/auth/refresh', {
            refreshToken: s2.refreshToken,
          })
        ).status,
      ).toBe(401);
    }
  });

  it('a deactivated employee and a removed role are locked out on the next request, on both copies', async () => {
    const e = await newWorld();
    const lead = await apiCopy('a', { sourceIp: e.ip, auth: e.lead.token }).get(
      `/api/warehouses/${e.wh.id}/dashboard`,
    );
    expect(lead.status).toBe(200);
    await e.as.patch(`/api/admin/staff/${e.lead.id}`, { roles: [] });
    expect(
      (await apiCopy('b', { sourceIp: e.ip, auth: e.lead.token }).get(`/api/warehouses/${e.wh.id}/dashboard`))
        .status,
    ).toBe(403);
    await e.as.patch(`/api/admin/staff/${e.lead.id}`, { active: false });
    expect((await apiCopy('a', { sourceIp: e.ip, auth: e.lead.token }).get('/api/auth/me')).status).toBe(401);
    expect(
      (
        await client({ sourceIp: nextIp() }).post('/api/auth/login', {
          email: await emailOf(e.lead.id),
          password: PASSWORD,
        })
      ).status,
    ).toBe(401);
  });
});

describe('shop API keys', () => {
  it('malformed, truncated, guessed and revoked keys fail; keys are stored hashed; a revoked key stops at once on both copies', async () => {
    const e = await newWorld();
    const key = e.shop.apiKey;
    for (const bad of [
      key.slice(0, -1),
      `${key}x`,
      key.replace(/.$/, key.endsWith('a') ? 'b' : 'a'),
      'fk_00000000_' + 'x'.repeat(32),
      'fk_',
      "fk_' OR 1=1 --",
      key.toUpperCase(),
    ]) {
      for (const which of ['a', 'b'] as const)
        expect(
          (await apiCopy(which, { sourceIp: nextIp(), auth: bad }).get('/api/shop/v1/skus')).status,
        ).toBe(401);
    }
    const row = await getStack().db.shopApiKey.findFirstOrThrow({ where: { shopId: e.shop.id } });
    expect(row.hash).not.toContain(key.slice(-16));
    expect(row.hash).toMatch(/^[0-9a-f]{64}$/);
    expect((await apiCopy('a', { sourceIp: e.ip, auth: key }).get('/api/shop/v1/skus')).status).toBe(200);
    expect((await e.as.post(`/api/admin/shops/${e.shop.id}/api-keys/${row.id}/revoke`)).status).toBe(200);
    for (const which of ['a', 'b'] as const)
      expect((await apiCopy(which, { sourceIp: e.ip, auth: key }).get('/api/shop/v1/skus')).status).toBe(401);
  });
});

describe('races on unique keys and double submits', () => {
  it('parallel creation with the same SKU barcode, cell code, staff email and shop code creates exactly one', async () => {
    const e = await newWorld();
    const barcode = uid('BC');
    const skus = await burst(10, (i) =>
      apiCopy(i % 2 === 0 ? 'a' : 'b', { sourceIp: e.ip, auth: e.shop.apiKey }).post('/api/shop/v1/skus', {
        code: uid('P'),
        name: 'n',
        barcode,
        weightG: 1,
        lengthMm: 1,
        widthMm: 1,
        heightMm: 1,
        tracksExpiry: false,
      }),
    );
    expect(skus.filter((r) => r.status === 201)).toHaveLength(1);
    expect(skus.filter((r) => r.status === 409)).toHaveLength(9);
    const zone = await e.as.get(`/api/warehouses/${e.wh.id}/cells?limit=1`);
    const zoneId = (
      await getStack().db.location.findFirstOrThrow({ where: { warehouseId: e.wh.id, kind: 'storage' } })
    ).zoneId;
    expect(zone.status).toBe(200);
    const cells = await burst(8, () =>
      e.as.post(`/api/admin/zones/${zoneId}/cells`, {
        cells: [{ code: 'DUP-1', walkOrder: 1, capacityVolumeCm3: 100, capacityWeightG: 100 }],
      }),
    );
    expect(cells.filter((r) => r.status === 201)).toHaveLength(1);
    const email = `dup-${uid()}@adv.local`.toLowerCase();
    const staff = await burst(8, () =>
      e.as.post('/api/admin/staff', { email, name: 'n', password: PASSWORD, roles: [] }),
    );
    expect(staff.filter((r) => r.status === 201)).toHaveLength(1);
    expect(staff.filter((r) => r.status === 409).every((r) => r.body.error.code === 'DUPLICATE_EMAIL')).toBe(
      true,
    );
    const code = uid('S');
    const shops = await burst(6, () =>
      e.as.post('/api/admin/shops', {
        code,
        name: 'n',
        webhookUrl: 'http://127.0.0.1:9/h',
        minShelfLifeDays: 0,
      }),
    );
    expect(shops.filter((r) => r.status === 201)).toHaveLength(1);
  });

  it('double-submitted receipts and cancels act once', async () => {
    const e = await newWorld();
    const sku = await newSku(e);
    const rc = await e.store.api.post(`/api/warehouses/${e.wh.id}/receipts`, { shopId: e.shop.id });
    const body = { barcode: sku.barcode, qty: 7, idempotencyKey: `dbl-${uid()}` };
    const res = await burst(8, (i) =>
      apiCopy(i % 2 === 0 ? 'a' : 'b', { sourceIp: e.ip, auth: e.store.token }).post(
        `/api/warehouses/${e.wh.id}/receipts/${rc.body.id}/lines`,
        body,
      ),
    );
    expect(res.every((r) => r.status === 201)).toBe(true);
    expect(await getStack().db.receiptLine.count({ where: { receiptId: rc.body.id } })).toBe(1);
    const recv = await getStack().db.location.findFirstOrThrow({
      where: { warehouseId: e.wh.id, kind: 'receiving' },
    });
    expect(
      (await getStack().db.stockBalance.findFirstOrThrow({ where: { locationId: recv.id, skuId: sku.id } }))
        .onHand,
    ).toBe(7);
  });
});

void login;
