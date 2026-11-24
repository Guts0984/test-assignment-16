// Mutation check: disable one protection at a time, run the tests that must catch it, expect them
// to FAIL, then restore the file. A protection whose removal goes unnoticed is not tested.
// Usage: pnpm tsx scripts/mutation-check.ts   (needs the docker compose postgres + redis running)
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

type Mutation = {
  readonly name: string;
  readonly file: string;
  readonly find: string;
  readonly replace: string;
  readonly cwd: string;
  readonly cmd: readonly string[];
};

const API = 'apps/api';
const vitestInt = (...args: string[]): string[] => [
  'npx',
  'vitest',
  'run',
  '-c',
  'vitest.int.config.mts',
  ...args,
];

const mutations: readonly Mutation[] = [
  {
    name: 'rate limiter always allows',
    file: 'apps/api/src/common/rate-limit/limiter.ts',
    find: 'return decide(n, limit, windowEnd, t, false);',
    replace: 'return decide(0, limit, windowEnd, t, false);',
    cwd: API,
    cmd: vitestInt('test/integration/rate-limiter.int.spec.ts'),
  },
  {
    name: 'auth guard lets every request in',
    file: 'apps/api/src/common/auth/auth.guard.ts',
    find: "if (ctx.getType() !== 'http') return true;",
    replace: 'return true;',
    cwd: API,
    cmd: vitestInt(
      'test/integration/errors-openapi.int.spec.ts',
      'test/integration/shop-isolation.int.spec.ts',
    ),
  },
  {
    name: 'input validator: order quantity accepts zero and negatives',
    file: 'packages/shared/src/schemas/common.ts',
    find: 'export const qtySchema = z.number().int().min(1).max(MAX_QTY);',
    replace: 'export const qtySchema = z.number().int().min(-1000).max(MAX_QTY);',
    cwd: 'packages/shared',
    cmd: ['npx', 'vitest', 'run', 'src/schemas'],
  },
  {
    name: 'concurrency guard: the order row lock (cancel vs scan vs pack)',
    file: 'packages/core/src/orders/transition.ts',
    find: 'WHERE id = ${orderId}::uuid FOR UPDATE`;',
    replace: 'WHERE id = ${orderId}::uuid`;',
    cwd: API,
    cmd: vitestInt('test/integration/floor-stock.int.spec.ts', '-t', 'order row lock'),
  },
  {
    name: 'concurrency guard: the stock balance row lock (reserve)',
    file: 'packages/core/src/floor/ledger-ops.ts',
    find: 'FOR UPDATE OF b FOR SHARE OF l`;',
    replace: '`;',
    cwd: 'apps/worker',
    cmd: [
      'npx',
      'vitest',
      'run',
      '-c',
      'vitest.int.config.mts',
      'test/integration/jobs.int.spec.ts',
      '-t',
      'acceptance #3',
    ],
  },
  {
    name: 'concurrency guard: scan idempotency key claim',
    file: 'packages/core/src/floor/idempotency.ts',
    find: 'ON CONFLICT (scope, key) DO NOTHING RETURNING key`;',
    replace: 'ON CONFLICT (scope, key) DO UPDATE SET request_hash = EXCLUDED.request_hash RETURNING key`;',
    cwd: API,
    cmd: vitestInt('test/integration/floor-flow.int.spec.ts', '-t', 'same scan repeated'),
  },
];

const run = (m: Mutation): { failed: boolean; tail: string } => {
  const r = spawnSync(m.cmd[0] ?? '', m.cmd.slice(1), { cwd: m.cwd, encoding: 'utf8', timeout: 600_000 });
  const out = `${r.stdout}${r.stderr}`;
  return {
    failed: r.status !== 0,
    tail: out
      .split('\n')
      .filter((l) => /Tests |×|FAIL/.test(l))
      .slice(0, 3)
      .join(' | '),
  };
};

const rows: string[] = [];
let missed = 0;
for (const m of mutations) {
  const original = readFileSync(m.file, 'utf8');
  if (!original.includes(m.find)) {
    console.error(`cannot apply "${m.name}": pattern not found in ${m.file}`);
    process.exit(2);
  }
  const baseline = run(m);
  if (baseline.failed) {
    console.error(`baseline already failing for "${m.name}": ${baseline.tail}`);
    process.exit(2);
  }
  try {
    writeFileSync(m.file, original.replace(m.find, m.replace));
    const mutated = run(m);
    const caught = mutated.failed;
    if (!caught) missed += 1;
    rows.push(
      `| ${m.name} | \`${m.file}\` | ${caught ? 'tests FAILED (caught)' : '**tests still passed (MISSED)**'} | ${mutated.tail} |`,
    );
    console.log(`${caught ? 'caught' : 'MISSED'}: ${m.name}  ${mutated.tail}`);
  } finally {
    writeFileSync(m.file, original);
  }
}
console.log(
  `\n| Protection disabled | File | Result | Evidence |\n| --- | --- | --- | --- |\n${rows.join('\n')}`,
);
process.exit(missed === 0 ? 0 : 1);
