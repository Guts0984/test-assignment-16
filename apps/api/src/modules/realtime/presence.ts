// Who is online (pickers on the floor): Redis keys with a TTL refreshed by socket heartbeats, so a
// client that disappears without a clean disconnect drops off on its own.
import { type Redis } from 'ioredis';

const key = (warehouseId: string, staffId: string): string => `presence:${warehouseId}:${staffId}`;

export const touchPresence = async (
  redis: Redis,
  warehouseIds: readonly string[],
  staffId: string,
  ttlSec: number,
): Promise<void> => {
  if (warehouseIds.length === 0) return;
  const m = redis.multi();
  for (const w of warehouseIds) m.set(key(w, staffId), '1', 'EX', ttlSec);
  await m.exec();
};

export const clearPresence = async (
  redis: Redis,
  warehouseIds: readonly string[],
  staffId: string,
): Promise<void> => {
  if (warehouseIds.length > 0) await redis.del(...warehouseIds.map((w) => key(w, staffId)));
};

export const presenceOnline = async (redis: Redis, warehouseId: string): Promise<Set<string>> => {
  const found = new Set<string>();
  const step = async (cursor: string): Promise<void> => {
    const [next, keys] = await redis.scan(cursor, 'MATCH', `presence:${warehouseId}:*`, 'COUNT', 500);
    for (const k of keys) found.add(k.slice(k.lastIndexOf(':') + 1));
    if (next !== '0') await step(next);
  };
  await step('0');
  return found;
};
