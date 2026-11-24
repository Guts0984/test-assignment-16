// In-memory state of the demo shop (restart clears it; plan.md A-34).
import { isNewerVersion } from '@ff/shared/rules/webhook';

export type ShopCreds = { readonly code: string; readonly apiKey: string; readonly webhookSecret: string };

export type ReceivedWebhook = {
  readonly seq: number;
  readonly shopCode: string;
  readonly eventId: string | null;
  readonly type: string | null;
  readonly stream: string | null;
  readonly version: number | null;
  readonly data: unknown;
  readonly signature: 'valid' | 'malformed' | 'stale' | 'mismatch' | 'unknown_shop';
  readonly outcome: 'accepted' | 'stale_version' | 'duplicate' | 'rejected' | 'fault_500' | 'fault_timeout';
  readonly receivedAt: string;
};

const MAX_KEPT = 20_000;

export const createStore = () => {
  const shops = new Map<string, ShopCreds>();
  const received: ReceivedWebhook[] = [];
  const lastVersion = new Map<string, number>();
  const latest = new Map<string, unknown>();
  const seenEvents = new Set<string>();
  const counters = { deliveries: 0, seq: 0 };
  return {
    registerShop: (c: ShopCreds) => void shops.set(c.code, c),
    shop: (code: string) => shops.get(code),
    shops: () => [...shops.values()],
    nextDelivery: () => (counters.deliveries += 1),
    /** Applies the receiver rule: accept only versions newer than the last seen for the stream. */
    accept: (shopCode: string, eventId: string, stream: string, version: number, data: unknown): ReceivedWebhook['outcome'] => {
      if (seenEvents.has(eventId)) return 'duplicate';
      seenEvents.add(eventId);
      const key = `${shopCode}|${stream}`;
      if (!isNewerVersion(version, lastVersion.get(key) ?? null)) return 'stale_version';
      lastVersion.set(key, version);
      latest.set(key, data);
      return 'accepted';
    },
    record: (w: Omit<ReceivedWebhook, 'seq'>) => {
      counters.seq += 1;
      received.push({ ...w, seq: counters.seq });
      if (received.length > MAX_KEPT) received.splice(0, received.length - MAX_KEPT);
    },
    received: (filter: { shopCode?: string; stream?: string } = {}) =>
      received.filter((r) => (filter.shopCode === undefined || r.shopCode === filter.shopCode) && (filter.stream === undefined || r.stream === filter.stream)),
    latest: (shopCode: string) =>
      [...latest.entries()].filter(([k]) => k.startsWith(`${shopCode}|`)).map(([k, data]) => ({ stream: k.slice(shopCode.length + 1), version: lastVersion.get(k) ?? 0, data })),
    reset: () => {
      received.length = 0;
      lastVersion.clear();
      latest.clear();
      seenEvents.clear();
      counters.deliveries = 0;
    },
  };
};

export type Store = ReturnType<typeof createStore>;
