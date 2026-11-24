// Injected clock. In tests every api and worker process shares one offset stored in Postgres
// (table test_clock) and broadcast via LISTEN/NOTIFY, so "advance 15 minutes" is seen everywhere.
import { Client } from 'pg';
import { type Db } from '@ff/db/client';

export type Clock = { readonly now: () => Date };

export const systemClock: Clock = Object.freeze({ now: () => new Date() });

export const fixedClock = (at: Date): Clock => ({ now: () => new Date(at.getTime()) });

export type SharedTestClock = {
  readonly clock: Clock;
  readonly offsetMs: () => number;
  readonly refresh: () => Promise<number>;
  readonly stop: () => Promise<void>;
};

const POLL_MS = 1000;

export const startSharedTestClock = async (databaseUrl: string): Promise<SharedTestClock> => {
  const state = { offset: 0, stopped: false };
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  const refresh = async (): Promise<number> => {
    const r = await client.query<{ offset_ms: string }>('SELECT offset_ms::text FROM test_clock WHERE id = 1');
    state.offset = Number(r.rows[0]?.offset_ms ?? 0);
    return state.offset;
  };
  client.on('notification', (n) => {
    if (n.channel === 'test_clock' && n.payload !== undefined) state.offset = Number(n.payload);
  });
  await client.query('LISTEN test_clock');
  await refresh();
  // A safety net in case a notification is missed (connection blip).
  const timer = setInterval(() => {
    if (!state.stopped) refresh().catch(() => undefined);
  }, POLL_MS);
  timer.unref();
  return {
    clock: { now: () => new Date(Date.now() + state.offset) },
    offsetMs: () => state.offset,
    refresh,
    stop: async () => {
      state.stopped = true;
      clearInterval(timer);
      await client.end();
    },
  };
};

export type ClockChange =
  | { readonly setTo: Date }
  | { readonly advanceMs: number }
  | { readonly reset: true };

/** Changes the shared test clock; returns the new offset. */
export const changeTestClock = async (db: Db, change: ClockChange): Promise<number> => {
  const [row] =
    'setTo' in change
      ? await db.$queryRaw<{ offset_ms: string }[]>`
          UPDATE test_clock SET offset_ms = ${change.setTo.getTime()}::bigint - (extract(epoch FROM clock_timestamp()) * 1000)::bigint
          WHERE id = 1 RETURNING offset_ms::text`
      : 'advanceMs' in change
        ? await db.$queryRaw<{ offset_ms: string }[]>`
            UPDATE test_clock SET offset_ms = offset_ms + ${change.advanceMs}::bigint WHERE id = 1 RETURNING offset_ms::text`
        : await db.$queryRaw<{ offset_ms: string }[]>`UPDATE test_clock SET offset_ms = 0 WHERE id = 1 RETURNING offset_ms::text`;
  return Number(row?.offset_ms ?? 0);
};
