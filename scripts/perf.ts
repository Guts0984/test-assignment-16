// Performance budgets on the FULL seed, through nginx (assignment): stock by SKU per warehouse
// < 200 ms, order search by number / customer / SKU < 300 ms, 90-day report < 1 s.
// Usage: docker compose up -d (SEED_PROFILE=full) then `pnpm perf`.
import { existsSync } from 'node:fs';
import { deriveSeedApiKey } from '../packages/shared/src/crypto/secrets';

if (existsSync('.env')) process.loadEnvFile('.env');
const env = (k: string): string => process.env[k] ?? '';
const base = `http://127.0.0.1:${env('NGINX_HOST_PORT')}`;
const RUNS = 30;

const get = async (path: string, token: string): Promise<{ status: number; ms: number; body: any }> => {
  const t = performance.now();
  const r = await fetch(`${base}${path}`, { headers: { authorization: `Bearer ${token}` } });
  const body = await r.json().catch(() => null);
  return { status: r.status, ms: performance.now() - t, body };
};
const p95 = (xs: number[]): number => [...xs].sort((a, b) => a - b)[Math.ceil(0.95 * xs.length) - 1] ?? 0;

const measure = async (
  name: string,
  budgetMs: number,
  call: (i: number) => Promise<{ status: number; ms: number; body: any }>,
): Promise<boolean> => {
  await call(0); // warm up caches and plans
  const ms: number[] = [];
  let bad = 0;
  for (let i = 0; i < RUNS; i += 1) {
    const r = await call(i);
    if (r.status !== 200) bad += 1;
    ms.push(r.ms);
  }
  const v = p95(ms);
  const ok = bad === 0 && v < budgetMs;
  console.log(
    `${ok ? 'ok  ' : 'FAIL'} ${name}: p95 ${v.toFixed(1)} ms (budget ${budgetMs} ms), median ${[...ms].sort((a, b) => a - b)[Math.floor(RUNS / 2)]?.toFixed(1)} ms${bad > 0 ? `, ${bad} non-200` : ''}`,
  );
  return ok;
};

const main = async (): Promise<void> => {
  const shopKey = deriveSeedApiKey(env('SEED_API_KEY_SALT'), 'SHOP1');
  const login = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'lead.kyiv@demo.local', password: env('SEED_DEMO_PASSWORD') }),
  });
  const lead = (await login.json()) as { accessToken: string; me: { roles: { warehouseId: string }[] } };
  const wid = lead.me.roles[0]?.warehouseId ?? '';
  const today = ((await (await fetch(`${base}/api/time`)).json()) as { now: string }).now.slice(0, 10);
  const from = new Date(Date.parse(`${today}T00:00:00Z`) - 89 * 86_400_000).toISOString().slice(0, 10);
  const counts = (await get('/api/shop/v1/orders?limit=1', shopKey)).body;
  console.log(`seed check: shop 1 has orders: ${(counts?.items?.length ?? 0 > 0) ? 'yes' : 'NO'}`);
  const results = [
    await measure('stock per SKU per warehouse (shop cabinet/API)', 200, (i) =>
      get(`/api/shop/v1/stock?q=S1-${String(1 + (i % 30) * 7).padStart(5, '0')}&limit=1`, shopKey),
    ),
    await measure('stock of a barcode at a warehouse (staff)', 200, (i) =>
      get(
        `/api/warehouses/${wid}/stock?sku=S1-${String(1 + (i % 30) * 11).padStart(5, '0')}`,
        lead.accessToken,
      ),
    ),
    await measure('order search by number', 300, (i) =>
      get(`/api/shop/v1/orders?q=S1-H${String(1000 + i * 37).padStart(7, '0')}`, shopKey),
    ),
    await measure('order search by customer', 300, (i) =>
      get(
        `/api/shop/v1/orders?q=${['Kovalenko', 'Olena Shevchenko', 'Nowak', 'Ivan Bondarenko'][i % 4]}`,
        shopKey,
      ),
    ),
    await measure('order search by SKU', 300, (i) =>
      get(`/api/shop/v1/orders?q=S1-${String(2 + (i % 20) * 5).padStart(5, '0')}`, shopKey),
    ),
    await measure('staff order search by customer', 300, (i) =>
      get(`/api/orders?q=${['Kovalenko', 'Nowak'][i % 2]}&warehouseId=${wid}`, lead.accessToken),
    ),
    await measure('90-day report', 1000, () =>
      get(`/api/reports/summary?from=${from}&to=${today}`, lead.accessToken),
    ),
  ];
  if (results.some((r) => !r)) {
    console.error('\nperformance budget exceeded');
    process.exit(1);
  }
  console.log('\nperf: all budgets met');
};

void main();
