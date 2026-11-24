// Smoke test through nginx against a running `docker compose` stack (acceptance #1).
// Usage: pnpm tsx scripts/compose-smoke.ts   (reads .env)
import { existsSync } from 'node:fs';
import { deriveSeedApiKey } from '../packages/shared/src/crypto/secrets';

if (existsSync('.env')) process.loadEnvFile('.env');
const env = (k: string): string => {
  const v = process.env[k];
  if (v === undefined) throw new Error(`${k} missing`);
  return v;
};
const base = `http://127.0.0.1:${env('NGINX_HOST_PORT')}`;
const stub = `http://127.0.0.1:${env('SHOP_STUB_HOST_PORT')}`;
const failures: string[] = [];
const check = (name: string, ok: boolean, detail = ''): void => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail === '' ? '' : ` (${detail})`}`);
  if (!ok) failures.push(name);
};
const json = async (url: string, init?: RequestInit) => {
  const r = await fetch(url, init);
  return { status: r.status, body: (await r.json().catch(() => null)) as any, headers: r.headers };
};

const waitFor = async (url: string, ms: number): Promise<boolean> => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (
      (await fetch(url)
        .then((r) => r.ok)
        .catch(() => false)) === true
    )
      return true;
    await new Promise((r) => setTimeout(r, 1000));
  }
  return false;
};

const main = async (): Promise<void> => {
  check('nginx serves the api health endpoint', await waitFor(`${base}/api/health`, 120_000));
  const instances = new Set<string>();
  for (let i = 0; i < 20; i += 1) instances.add((await json(`${base}/api/health`)).body?.instance);
  check(
    'both api copies answer through nginx',
    instances.has('a') && instances.has('b'),
    [...instances].join(','),
  );
  check('swagger is served at /docs', (await fetch(`${base}/docs`)).status === 200);
  check('web login page is served', (await fetch(`${base}/login`)).status === 200);
  check('shop stub page is served', (await fetch(stub)).status === 200);
  const login = await json(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'admin@demo.local', password: env('SEED_DEMO_PASSWORD') }),
  });
  check('seeded admin can sign in', login.status === 200 && typeof login.body?.accessToken === 'string');
  const wh = await json(`${base}/api/admin/warehouses`, {
    headers: { authorization: `Bearer ${login.body?.accessToken}` },
  });
  check(
    'two warehouses in two time zones were seeded',
    wh.status === 200 && new Set(wh.body?.items?.map((w: { timeZone: string }) => w.timeZone)).size === 2,
  );
  const key = deriveSeedApiKey(env('SEED_API_KEY_SALT'), 'SHOP1');
  const stock = await json(`${base}/api/shop/v1/stock?limit=5`, {
    headers: { authorization: `Bearer ${key}` },
  });
  check('a seeded shop API key reads stock', stock.status === 200 && stock.body?.items?.length > 0);
  const other = await json(`${base}/api/admin/shops`, { headers: { authorization: `Bearer ${key}` } });
  check('a shop key cannot reach admin routes', other.status === 403);
  const spoof = await json(`${base}/api/health`, {
    headers: { 'x-real-ip': '1.2.3.4', 'x-forwarded-for': '5.6.7.8' },
  });
  check('spoofed client-IP headers do not break requests', spoof.status === 200);
  if (failures.length > 0) {
    console.error(`\n${failures.length} smoke check(s) failed`);
    process.exit(1);
  }
  console.log('\nsmoke: all checks passed');
};

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
