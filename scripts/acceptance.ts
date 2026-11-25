// The 17 acceptance checks of the assignment, run and summarised in one table.
// Prerequisites: `docker compose up -d` (full seed) for #1, #16, #17; Postgres and Redis for the tests.
// Usage: pnpm acceptance            (everything)
//        pnpm acceptance --skip-stack   (skips the checks that need the full compose stack: #1 #16 #17)
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

if (existsSync('.env')) process.loadEnvFile('.env');
const skipStack = process.argv.includes('--skip-stack');
const onlyArg = process.argv.find((a) => a.startsWith('--only='))?.slice('--only='.length);
const only = onlyArg === undefined ? null : new Set(onlyArg.split(',').map(Number));
const wanted = (n: number): boolean => only === null || only.has(n);
type Result = {
  readonly n: number;
  readonly name: string;
  readonly ok: boolean | null;
  readonly evidence: string;
};
const results: Result[] = [];
const run = (cmd: string, args: string[], cwd = '.'): { ok: boolean; out: string } => {
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf8', timeout: 3_600_000, maxBuffer: 1 << 28 });
  return { ok: r.status === 0, out: `${r.stdout}${r.stderr}` };
};
const record = (n: number, name: string, ok: boolean | null, evidence: string): void => {
  if (!wanted(n)) return;
  results.push({ n, name, ok, evidence });
  console.log(`${ok === null ? 'SKIP' : ok ? 'PASS' : 'FAIL'} #${n} ${name}: ${evidence}`);
};

// 1. compose + smoke through nginx
if (skipStack) record(1, 'docker compose up, no manual steps', null, 'skipped (--skip-stack)');
else {
  const s = run('pnpm', ['smoke']);
  record(
    1,
    'docker compose up, no manual steps',
    s.ok,
    s.out
      .trim()
      .split('\n')
      .filter((l) => l.startsWith('smoke') || l.startsWith('FAIL'))
      .join('; '),
  );
}

// 2. typecheck, lint, client unchanged, tests
const steps: [string, string[]][] = [
  ['typecheck', ['typecheck']],
  ['lint', ['lint']],
  ['unit tests', ['test']],
  ['integration tests', ['test:int']],
];
let step2 = true;
const evidence2: string[] = [];
const gen = run('sh', [
  '-c',
  'pnpm --filter @ff/api build >/dev/null && pnpm --filter @ff/api openapi:export >/dev/null && pnpm --filter @ff/web api:generate >/dev/null && git diff --exit-code -- apps/api/openapi.json apps/web/src/shared/api/generated',
]);
evidence2.push(`generated client unchanged: ${gen.ok}`);
step2 &&= gen.ok;
for (const [name, args] of steps) {
  const r = run('pnpm', args);
  evidence2.push(`${name}: ${r.ok}`);
  step2 &&= r.ok;
}
record(
  2,
  'typecheck, lint, client unchanged, tests (CI runs this on every commit: pnpm verify-history)',
  step2,
  evidence2.join(', '),
);

// 3-15. the adversarial suite, matched by test title "acceptance #N"
const outFile = join(mkdtempSync(join(tmpdir(), 'acc-')), 'adv.json');
const adv = run(
  'npx',
  ['vitest', 'run', '-c', 'vitest.adv.config.mts', '--reporter=json', `--outputFile=${outFile}`],
  'apps/api',
);
type T = { fullName: string; status: string; failureMessages?: string[] };
const tests: T[] = existsSync(outFile)
  ? (
      JSON.parse(readFileSync(outFile, 'utf8')) as { testResults: { assertionResults: T[] }[] }
    ).testResults.flatMap((f) => f.assertionResults)
  : [];
const NAMES: Record<number, string> = {
  3: '300 simultaneous orders on 100 units',
  4: 'batches 10/40/90 days, minimum 30',
  5: 'receipt of 20 with 50 waiting orders',
  6: 'two scans of one position, repeated scan',
  7: 'cancel at the moment of the last scan',
  8: 'shortage during picking',
  9: 'count of a cell being picked, difference 7',
  10: 'packed 17:01, cutoff 17:00, Friday, Warsaw',
  11: 'one order 10x to both copies, chaos webhooks',
  12: 'kill -9 and FLUSHALL',
  13: 'ledger vs stock after all checks',
  14: 'lead on copy A, picker on copy B',
  15: 'other shop / warehouse / picker',
};
for (let n = 3; n <= 15; n += 1) {
  const mine = tests.filter((t) => new RegExp(`acceptance #${n}\\b`).test(t.fullName));
  const ok = mine.length > 0 && mine.every((t) => t.status === 'passed');
  record(
    n,
    NAMES[n] ?? '',
    ok,
    `${mine.filter((t) => t.status === 'passed').length}/${mine.length} adversarial tests passed${adv.ok ? '' : ' (suite reported failures)'}`,
  );
}

// 16. budgets on the full seed, URL state in the browser
if (skipStack)
  record(16, 'stock / search / 90-day report budgets; state in the URL', null, 'skipped (--skip-stack)');
else {
  const perf = run('pnpm', ['perf']);
  const url = run('npx', [
    'playwright',
    'test',
    '-c',
    'e2e/playwright.config.ts',
    'e2e/ui.e2e.ts',
    '-g',
    'report period and filters live in the URL',
  ]);
  record(
    16,
    'stock / search / 90-day report budgets; state in the URL',
    perf.ok && url.ok,
    `perf: ${perf.out
      .split('\n')
      .filter((l) => l.startsWith('perf') || l.startsWith('FAIL'))
      .join('; ')}; playwright URL test: ${url.ok}`,
  );
}

// 17. README
if (skipStack) record(17, 'README matches behaviour', null, 'skipped (--skip-stack)');
else {
  const rc = run('pnpm', ['readme-check']);
  record(
    17,
    'README matches behaviour',
    rc.ok,
    rc.out
      .split('\n')
      .filter((l) => l.startsWith('readme-check') || l.startsWith('FAIL'))
      .join('; '),
  );
}

console.log('\n| # | Check | Result | Evidence |\n| --- | --- | --- | --- |');
for (const r of results)
  console.log(
    `| ${r.n} | ${r.name} | ${r.ok === null ? 'skipped' : r.ok ? 'PASS' : 'FAIL'} | ${r.evidence} |`,
  );
process.exit(results.some((r) => r.ok === false) ? 1 : 0);
