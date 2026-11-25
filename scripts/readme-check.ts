// Acceptance #17: the README must match the code and the running system.
//  - every required section exists
//  - the status table equals the one generated from packages/shared
//  - every index, constraint, trigger and view it names exists in Postgres
//  - every `pnpm <script>` it mentions exists
//  - every login and API key it lists works against the running stack (skipped when the stack is down)
import { existsSync, readFileSync } from 'node:fs';
import { createDb } from '../packages/db/src/client';
import { transitionTableMarkdown } from '../packages/shared/src/rules/status';

if (existsSync('.env')) process.loadEnvFile('.env');
const readme = readFileSync('README.md', 'utf8');
const failures: string[] = [];
const check = (name: string, ok: boolean, detail = ''): void => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail === '' ? '' : ` (${detail})`}`);
  if (!ok) failures.push(name);
};

const SECTIONS = [
  'Run and test',
  'How reservation, FEFO and "stock never goes negative" work',
  'Protection against concurrent actions: scan, cancel, stock count',
  'Cutoff and shipping day',
  'Background jobs',
  'Webhooks',
  'Order statuses',
  'Indexes and constraints',
  'Decisions made',
];
for (const s of SECTIONS)
  check(
    `section "${s}"`,
    new RegExp(`^## \\d+\\. ${s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'm').test(readme),
  );
check('the README has a DST example', /clocks go forward/.test(readme) && /CEST/.test(readme));
check(
  'the README lists logins and API keys',
  /admin@demo\.local/.test(readme) && /fk_[0-9a-f]{8}_/.test(readme),
);

const table =
  /<!-- status-table:start -->\n([\s\S]*?)\n<!-- status-table:end -->/.exec(readme)?.[1]?.trim() ?? '';
check(
  'status table equals the one generated from packages/shared',
  table === transitionTableMarkdown().trim(),
);

const scripts = (JSON.parse(readFileSync('package.json', 'utf8')) as { scripts: Record<string, string> })
  .scripts;
const mentioned = [...new Set([...readme.matchAll(/pnpm ([a-z][\w:-]*)/g)].map((m) => m[1] ?? ''))].filter(
  (n) => !['install', 'dlx'].includes(n),
);
for (const n of mentioned) check(`pnpm script "${n}" exists`, n in scripts || ['--filter'].includes(n));

const main = async (): Promise<void> => {
  const db = createDb({ url: process.env.DATABASE_URL ?? '', poolSize: 1 });
  try {
    const names = new Set<string>();
    for (const r of await db.$queryRaw<{ n: string }[]>`
      SELECT indexname AS n FROM pg_indexes WHERE schemaname = 'public'
      UNION SELECT conname FROM pg_constraint WHERE connamespace = 'public'::regnamespace
      UNION SELECT tgname FROM pg_trigger WHERE NOT tgisinternal
      UNION SELECT viewname FROM pg_views WHERE schemaname = 'public'`)
      names.add(r.n);
    const section = /## 8\. Indexes and constraints([\s\S]*?)## 9\./.exec(readme)?.[1] ?? '';
    const section2 = /## 2\. How reservation([\s\S]*?)## 3\./.exec(readme)?.[1] ?? '';
    const tokens = [
      ...new Set([...(section + section2).matchAll(/`([a-z][a-z0-9_]+)`/g)].map((m) => m[1] ?? '')),
    ].filter(
      (t) =>
        /_/.test(t) &&
        (t.includes('_key') ||
          /^(orders|skus|locations|staff|wave|pick|stock|receipt|transfers|scheduled|webhook|order|adjustments|warehouses|ledger|reservation|test_clock)_/.test(
            t,
          )),
    );
    const tableNames = new Set(
      (
        await db.$queryRaw<{ n: string }[]>`SELECT tablename AS n FROM pg_tables WHERE schemaname = 'public'`
      ).map((r) => r.n),
    );
    const columns = new Set(
      (
        await db.$queryRaw<
          { n: string }[]
        >`SELECT DISTINCT column_name AS n FROM information_schema.columns WHERE table_schema = 'public'`
      ).map((r) => r.n),
    );
    const named = tokens.filter((t) => !tableNames.has(t) && !columns.has(t));
    check(
      `${named.length} named indexes, constraints, triggers and views exist in Postgres`,
      named.length > 15,
    );
    for (const t of named) check(`database object "${t}"`, names.has(t));
  } finally {
    await db.$disconnect();
  }

  const base = `http://127.0.0.1:${process.env.NGINX_HOST_PORT ?? '8080'}`;
  const up = await fetch(`${base}/api/health`)
    .then((r) => r.ok)
    .catch(() => false);
  if (!up) {
    console.log('skip credentials: the compose stack is not running');
  } else {
    const emails = [...new Set([...readme.matchAll(/`([a-z0-9.]+@demo\.local)`/g)].map((m) => m[1] ?? ''))];
    const expanded = emails.flatMap((e) =>
      e === 'picker1.kyiv@demo.local'
        ? ['picker1', 'picker2', 'picker3'].flatMap((p) =>
            ['kyiv', 'warsaw'].map((c) => `${p}.${c}@demo.local`),
          )
        : e === 'shop1@demo.local'
          ? [1, 2, 3, 4, 5].map((n) => `shop${n}@demo.local`)
          : [e],
    );
    for (const email of new Set(expanded)) {
      const r = await fetch(`${base}/api/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email, password: process.env.SEED_DEMO_PASSWORD }),
      });
      check(`login ${email}`, r.status === 200);
    }
    for (const k of new Set(
      [...readme.matchAll(/`(fk_[0-9a-f]{8}_[A-Za-z0-9]{32})`/g)].map((m) => m[1] ?? ''),
    )) {
      const r = await fetch(`${base}/api/shop/v1/stock?limit=1`, {
        headers: { authorization: `Bearer ${k}` },
      });
      check(`API key ${k.slice(0, 11)}...`, r.status === 200);
    }
  }
  if (failures.length > 0) {
    console.error(`\n${failures.length} README check(s) failed`);
    process.exit(1);
  }
  console.log('\nreadme-check: the README matches the code and the running system');
};

void main();
