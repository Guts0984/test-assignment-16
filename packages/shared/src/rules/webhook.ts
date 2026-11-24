// Webhook coalescing, versions and signatures (ASSIGNMENT "Webhooks", plan.md A-25, A-26).
import { createHmac, timingSafeEqual } from 'node:crypto';

/** When the next stock webhook for one (shop, SKU) may be sent: at most once per window. */
export const nextStockSendAt = (now: Date, lastSentAt: Date | null, windowMs: number): Date =>
  lastSentAt === null ? now : new Date(Math.max(now.getTime(), lastSentAt.getTime() + windowMs));

export const canSendStockNow = (now: Date, lastSentAt: Date | null, windowMs: number): boolean =>
  lastSentAt === null || now.getTime() - lastSentAt.getTime() >= windowMs;

/** A receiver keeps an event only if its version is newer than the last one seen for the stream. */
export const isNewerVersion = (incoming: number, lastSeen: number | null): boolean =>
  lastSeen === null || incoming > lastSeen;

/** Exponential backoff with a cap; attempt 1 is the first retry. */
export const backoffMs = (attempt: number, baseMs: number, maxMs: number): number =>
  Math.min(maxMs, baseMs * 2 ** Math.max(0, attempt - 1));

export const SIGNATURE_HEADER = 'x-fulfillment-signature';
export const EVENT_ID_HEADER = 'x-fulfillment-event-id';

const hmacHex = (secret: string, payload: string): string =>
  createHmac('sha256', secret).update(payload).digest('hex');

export const signWebhook = (secret: string, rawBody: string, unixSeconds: number): string =>
  `t=${unixSeconds},v1=${hmacHex(secret, `${unixSeconds}.${rawBody}`)}`;

export type SignatureCheck =
  | { readonly ok: true; readonly timestamp: number }
  | { readonly ok: false; readonly reason: 'malformed' | 'stale' | 'mismatch' };

export const verifyWebhook = (
  secret: string,
  rawBody: string,
  header: string | undefined,
  nowUnixSeconds: number,
  maxSkewSec: number,
): SignatureCheck => {
  const m = /^t=(\d{1,12}),v1=([0-9a-f]{64})$/.exec(header ?? '');
  if (m === null) return { ok: false, reason: 'malformed' };
  const ts = Number(m[1]);
  if (Math.abs(nowUnixSeconds - ts) > maxSkewSec) return { ok: false, reason: 'stale' };
  const expected = Buffer.from(hmacHex(secret, `${ts}.${rawBody}`), 'hex');
  const given = Buffer.from(m[2] ?? '', 'hex');
  return expected.length === given.length && timingSafeEqual(expected, given)
    ? { ok: true, timestamp: ts }
    : { ok: false, reason: 'mismatch' };
};

/** What a shop receives. `version` grows per stream; a receiver drops anything not newer. */
export type WebhookEnvelope = {
  readonly eventId: string;
  readonly type: 'order.status_changed' | 'stock.available_changed';
  readonly stream: string;
  readonly version: number;
  readonly occurredAt: string;
  readonly data: Readonly<Record<string, unknown>>;
};
