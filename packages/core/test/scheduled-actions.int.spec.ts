// Exactly-once semantics of Postgres-backed scheduled actions under races, crashes and reruns.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, type Db } from '@ff/db/client';
import { withTx } from '@ff/db/tx';
import {
  claimAction,
  dueActions,
  failClaim,
  finishClaim,
  jobIdFor,
  rerunDeadAction,
  scheduleAction,
} from '../src/scheduled-actions';
import { testEnv } from './setup/test-env';

let db: Db;
beforeAll(() => {
  db = createDb({ url: testEnv.DATABASE_URL, poolSize: 20 });
});
afterAll(async () => db.$disconnect());

const t0 = new Date('2030-01-01T00:00:00Z');
const plus = (ms: number): Date => new Date(t0.getTime() + ms);
const fresh = async (dueAt = t0) => {
  const key = randomUUID();
  await scheduleAction(db, { kind: 'wave_timer', key, dueAt });
  return db.scheduledAction.findUniqueOrThrow({ where: { kind_key: { kind: 'wave_timer', key } } });
};

describe('claims', () => {
  it('ten workers race for one due row: exactly one claim', async () => {
    const row = await fresh();
    const claims = await Promise.all(Array.from({ length: 10 }, (_, i) => claimAction(db, row.id, `w${i}`, t0, 30_000)));
    expect(claims.filter((c) => c !== null)).toHaveLength(1);
  });

  it('a row is not claimable before it is due (one tick before vs at due time)', async () => {
    const row = await fresh(plus(1000));
    expect(await claimAction(db, row.id, 'w', plus(999), 30_000)).toBeNull();
    expect(await claimAction(db, row.id, 'w', plus(1000), 30_000)).not.toBeNull();
  });

  it('a crashed worker (kill -9) loses the claim after the lease; the effect runs once in total', async () => {
    const row = await fresh();
    const dead = await claimAction(db, row.id, 'dead-worker', t0, 5000);
    expect(dead).not.toBeNull();
    expect(await claimAction(db, row.id, 'w2', plus(4999), 5000)).toBeNull();
    const second = await claimAction(db, row.id, 'w2', plus(5001), 5000);
    expect(second).not.toBeNull();
    const effects: string[] = [];
    if (second !== null) {
      await withTx(db, async (tx) => {
        if (await finishClaim(tx, second, null)) effects.push('w2');
      });
    }
    // The zombie wakes up and tries to finish with its stale claim: refused, effect must roll back.
    if (dead !== null) {
      await withTx(db, async (tx) => {
        if (await finishClaim(tx, dead, null)) effects.push('zombie');
      });
    }
    expect(effects).toEqual(['w2']);
    expect((await db.scheduledAction.findUniqueOrThrow({ where: { id: row.id } })).status).toBe('done');
  });

  it('due rows include expired leases and exclude live ones', async () => {
    const live = await fresh();
    const expired = await fresh();
    await claimAction(db, live.id, 'w', t0, 60_000);
    await claimAction(db, expired.id, 'w', t0, 1000);
    const ids = (await dueActions(db, plus(2000), 10_000)).map((r) => r.id);
    expect(ids).toContain(expired.id);
    expect(ids).not.toContain(live.id);
  });

  it('job ids are deterministic per run and contain no colon', async () => {
    const row = await fresh();
    const a = jobIdFor({ id: row.id, runCount: 0, dueAt: t0 });
    expect(a).toBe(jobIdFor({ id: row.id, runCount: 0, dueAt: t0 }));
    expect(a).not.toContain(':');
    expect(jobIdFor({ id: row.id, runCount: 1, dueAt: t0 })).not.toBe(a);
  });
});

describe('recurrence and re-arming', () => {
  it('finishing with a next due time keeps the row pending for the next slot', async () => {
    const row = await fresh();
    const c = await claimAction(db, row.id, 'w', t0, 30_000);
    if (c === null) throw new Error('no claim');
    await withTx(db, (tx) => finishClaim(tx, c, { dueAt: plus(15 * 60_000) }));
    const after = await db.scheduledAction.findUniqueOrThrow({ where: { id: row.id } });
    expect([after.status, after.dueAt.toISOString()]).toEqual(['pending', plus(15 * 60_000).toISOString()]);
  });

  it('re-armed while running: runs again after the current run (no lost trigger)', async () => {
    const row = await fresh();
    const c = await claimAction(db, row.id, 'w', t0, 30_000);
    if (c === null) throw new Error('no claim');
    await scheduleAction(db, { kind: 'wave_timer', key: row.key, dueAt: t0 });
    await withTx(db, (tx) => finishClaim(tx, c, null));
    const after = await db.scheduledAction.findUniqueOrThrow({ where: { id: row.id } });
    expect([after.status, after.rearmed]).toEqual(['pending', false]);
  });

  it('scheduling a pending row keeps the earlier due time', async () => {
    const row = await fresh(plus(10_000));
    await scheduleAction(db, { kind: 'wave_timer', key: row.key, dueAt: plus(20_000) });
    await scheduleAction(db, { kind: 'wave_timer', key: row.key, dueAt: plus(5_000) });
    expect((await db.scheduledAction.findUniqueOrThrow({ where: { id: row.id } })).dueAt).toEqual(plus(5_000));
  });
});

describe('exhausted attempts', () => {
  it('dies after max attempts, then reruns exactly once when two admins click', async () => {
    const row = await fresh();
    const outcomes: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      const c = await claimAction(db, row.id, 'w', plus(i * 10_000), 30_000);
      if (c === null) throw new Error(`no claim at attempt ${i}`);
      outcomes.push(await failClaim(db, c, `boom ${i}`, plus(i * 10_000), 3, 1000));
    }
    expect(outcomes).toEqual(['retry', 'retry', 'dead']);
    const dead = await db.scheduledAction.findUniqueOrThrow({ where: { id: row.id } });
    expect([dead.status, dead.lastError]).toEqual(['dead', 'boom 2']);
    expect(await claimAction(db, row.id, 'w', plus(999_999), 30_000)).toBeNull();
    const reruns = await Promise.all([rerunDeadAction(db, row.id, t0), rerunDeadAction(db, row.id, t0)]);
    expect(reruns.filter(Boolean)).toHaveLength(1);
    expect((await db.scheduledAction.findUniqueOrThrow({ where: { id: row.id } })).status).toBe('pending');
  });
});
