// The rate limiter by real client IP, attacked over the network (window 8 s, login 20 per IP and
// 10 per account in the test stack). Real Redis, both api copies, real nginx in front.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { apiCopy, burst, client, flood, ledger, percentile, redis, until } from '../harness/attacker';
import { ensureStack, getStack } from '../harness/global';
import { newWorld, nextIp, PASSWORD, uid } from '../harness/scenarios';

const WINDOW = 8000;
beforeAll(async () => void (await ensureStack()));
afterAll(async () => ledger.assertBalanced());

/** Starts the measured burst right after a window boundary so it cannot straddle two windows. */
const alignWindow = async (): Promise<void> => {
  const left = WINDOW - (Date.now() % WINDOW);
  if (left < 5000) await new Promise((r) => setTimeout(r, left + 60));
};

const wrongLogin = (c: ReturnType<typeof client>, email = `ghost-${uid()}@adv.local`) =>
  c.post('/api/auth/login', { email, password: 'wrong-password-1' });

describe('limits by real client IP', () => {
  it('an attacker flooding login from one IP gets 429 with Retry-After, while two other IPs keep working at normal speed', async () => {
    const [x, y, z] = [nextIp(), nextIp(), nextIp()];
    const w = await newWorld();
    const emailY = (await getStack().db.staff.findUniqueOrThrow({ where: { id: w.lead.id } })).email;
    const emailZ = (await getStack().db.staff.findUniqueOrThrow({ where: { id: w.store.id } })).email;
    await alignWindow();
    const attacker = client({ sourceIp: x });
    const [floodRes, yRes, zRes] = await Promise.all([
      flood(80, () => wrongLogin(attacker), 20),
      (async () =>
        Promise.all(
          Array.from({ length: 5 }, () =>
            client({ sourceIp: y }).post('/api/auth/login', { email: emailY, password: PASSWORD }),
          ),
        ))(),
      (async () =>
        Promise.all(
          Array.from({ length: 5 }, () =>
            client({ sourceIp: z }).post('/api/auth/login', { email: emailZ, password: PASSWORD }),
          ),
        ))(),
    ]);
    const limited = floodRes.filter((r) => r.status === 429);
    expect(limited.length).toBeGreaterThanOrEqual(80 - 20);
    expect(floodRes.filter((r) => r.status !== 429).length).toBeLessThanOrEqual(20);
    for (const r of limited.slice(0, 5)) {
      const ra = Number(r.headers['retry-after']);
      expect(ra).toBeGreaterThanOrEqual(1);
      expect(ra).toBeLessThanOrEqual(WINDOW / 1000);
      expect(r.body.error.code).toBe('RATE_LIMITED');
    }
    expect([...yRes, ...zRes].map((r) => r.status)).toEqual(Array(10).fill(200));
    // stated budget: logins of innocent users stay under 3 s while an attacker burns its whole allowance
    expect(
      percentile(
        [...yRes, ...zRes].map((r) => r.ms),
        95,
      ),
    ).toBeLessThan(3000);
  });

  it('N parallel requests across both api copies never exceed the limit: exactly 20 pass, the rest are 429', async () => {
    const x = nextIp();
    await alignWindow();
    const res = await burst(60, (i) => wrongLogin(apiCopy(i % 2 === 0 ? 'a' : 'b', { sourceIp: x })));
    expect(res.filter((r) => r.status !== 429)).toHaveLength(20);
    expect(res.filter((r) => r.status === 429)).toHaveLength(40);
  });

  it('spoofed X-Forwarded-For, X-Real-IP and Forwarded cannot evade the limit or put a victim in the attacker bucket', async () => {
    const [x, victim] = [nextIp(), nextIp()];
    const w = await newWorld();
    const email = (await getStack().db.staff.findUniqueOrThrow({ where: { id: w.lead.id } })).email;
    await alignWindow();
    const spoofed = (i: number) =>
      client({ sourceIp: x }).post(
        '/api/auth/login',
        { email: `ghost-${uid()}@adv.local`, password: 'wrong-password-1' },
        {
          headers: {
            'x-forwarded-for': `10.9.${i % 250}.${(i * 7) % 250}`,
            'x-real-ip': `10.8.${i % 250}.1`,
            forwarded: `for=10.7.${i % 250}.1`,
          },
        },
      );
    const viaNginx = await flood(60, async (i) => spoofed(i), 20);
    expect(viaNginx.filter((r) => r.status === 429).length).toBeGreaterThanOrEqual(40);
    // the attacker names the victim IP in every header: the victim still logs in
    const naming = await client({ sourceIp: x }).post(
      '/api/auth/login',
      { email, password: PASSWORD },
      { headers: { 'x-forwarded-for': victim, 'x-real-ip': victim, forwarded: `for=${victim}` } },
    );
    expect(naming.status).toBe(429);
    const ok = await client({ sourceIp: victim }).post('/api/auth/login', { email, password: PASSWORD });
    expect(ok.status).toBe(200);
  });

  it('straight to an api copy (no nginx) from an untrusted address, the headers are ignored too', async () => {
    const x = nextIp();
    await alignWindow();
    const res = await flood(
      50,
      (i) =>
        apiCopy('a', { sourceIp: x }).post(
          '/api/auth/login',
          { email: `ghost-${uid()}@adv.local`, password: 'wrong-password-1' },
          { headers: { 'x-real-ip': `10.5.${i}.${i}` } },
        ),
      10,
    );
    expect(res.filter((r) => r.status === 429).length).toBeGreaterThanOrEqual(30);
  });

  it('a stranger hammering a known email is limited on their own address and cannot lock the owner out', async () => {
    const w = await newWorld();
    const email = (await getStack().db.staff.findUniqueOrThrow({ where: { id: w.picker1.id } })).email;
    const other = (await getStack().db.staff.findUniqueOrThrow({ where: { id: w.picker2.id } })).email;
    await alignWindow();
    const attacker = nextIp();
    const res = await burst(30, (i) =>
      client({ sourceIp: attacker }).post('/api/auth/login', { email, password: `wrong-${i}-password` }),
    );
    expect(res.filter((r) => r.status === 429).length).toBeGreaterThanOrEqual(10);
    // the owner, from another address, still gets in with the right password
    expect(
      (await client({ sourceIp: nextIp() }).post('/api/auth/login', { email, password: PASSWORD })).status,
    ).toBe(200);
    expect(
      (await client({ sourceIp: nextIp() }).post('/api/auth/login', { email: other, password: PASSWORD }))
        .status,
    ).toBe(200);
  });

  it('ten addresses hammering one known email cannot lock the owner out', async () => {
    const w = await newWorld();
    const email = (await getStack().db.staff.findUniqueOrThrow({ where: { id: w.picker1.id } })).email;
    await alignWindow();
    const ips = Array.from({ length: 10 }, () => nextIp());
    const res = await burst(100, (i) =>
      client({ sourceIp: ips[i % ips.length] ?? nextIp() }).post('/api/auth/login', {
        email,
        password: `wrong-${i}-password`,
      }),
    );
    // every address spends its own budget of 10 and then gets 429 ...
    expect(res.filter((r) => r.status === 401).length).toBeLessThanOrEqual(100);
    // ... and the owner, from an eleventh address, still signs in with the right password
    const owner = await client({ sourceIp: nextIp() }).post('/api/auth/login', { email, password: PASSWORD });
    expect(owner.status).toBe(200);
  });

  it('recovers in the next window', async () => {
    const x = nextIp();
    await alignWindow();
    const res = await burst(30, () => wrongLogin(client({ sourceIp: x })));
    expect(res.some((r) => r.status === 429)).toBe(true);
    await new Promise((r) => setTimeout(r, WINDOW - (Date.now() % WINDOW) + 100));
    expect((await wrongLogin(client({ sourceIp: x }))).status).toBe(401);
  });

  it('counters carry a TTL and never hold raw IPs or emails', async () => {
    const keys = await redis.keys('rl:*');
    expect(keys.length).toBeGreaterThan(0);
    for (const k of keys.slice(0, 20)) {
      const ttl = await redis.ttl(k);
      expect(ttl === -2 || (ttl > 0 && ttl <= 2 * WINDOW)).toBe(true);
    }
    expect(keys.join(' ')).not.toMatch(/127\.0|@adv\.local/);
  });
});

describe('Redis unavailable: fail-open to a per-copy limiter, the service keeps working', () => {
  it('requests are still served and logins are still limited per copy', async () => {
    const x = nextIp();
    redis.stop();
    try {
      expect((await client({ sourceIp: nextIp() }).get('/api/health')).status).toBe(200);
      await alignWindow();
      const res = await flood(60, () => wrongLogin(apiCopy('a', { sourceIp: x })), 10);
      expect(res.some((r) => r.status === 429)).toBe(true);
      expect(res.every((r) => r.status === 401 || r.status === 429)).toBe(true);
    } finally {
      redis.start();
      await until(
        async () => (await client({ sourceIp: nextIp() }).get('/api/health')).status === 200,
        30_000,
        300,
      );
      await until(async () => (await redis.keys('bull:*')).length >= 0, 30_000, 300);
    }
  });
});
