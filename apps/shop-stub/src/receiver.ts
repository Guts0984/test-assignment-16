// Webhook receipt: verify the HMAC signature over the raw body and timestamp, apply chaos faults,
// keep only newer versions per stream.
import { EVENT_ID_HEADER, SIGNATURE_HEADER, verifyWebhook } from '@ff/shared/rules/webhook';
import { webhookEnvelopeSchema } from '@ff/shared/schemas/webhook';
import { webhookFault, type ChaosSettings } from './chaos';
import { type Store } from './store';

export type ReceiveResult = { readonly status: number; readonly holdMs: number };

export const receiveWebhook = (
  store: Store,
  chaos: ChaosSettings,
  shopCode: string,
  rawBody: string,
  headers: Readonly<Record<string, string | string[] | undefined>>,
  now: Date,
  maxSkewSec: number,
): ReceiveResult => {
  const at = now.toISOString();
  const shop = store.shop(shopCode);
  const base = {
    shopCode,
    eventId: null,
    type: null,
    stream: null,
    version: null,
    data: null,
    receivedAt: at,
  };
  if (shop === undefined) {
    store.record({ ...base, signature: 'unknown_shop', outcome: 'rejected' });
    return { status: 404, holdMs: 0 };
  }
  const sigHeader = headers[SIGNATURE_HEADER];
  const sig = verifyWebhook(
    shop.webhookSecret,
    rawBody,
    typeof sigHeader === 'string' ? sigHeader : undefined,
    Math.floor(now.getTime() / 1000),
    maxSkewSec,
  );
  if (!sig.ok) {
    store.record({ ...base, signature: sig.reason, outcome: 'rejected' });
    return { status: 401, holdMs: 0 };
  }
  const parsed = (() => {
    try {
      return webhookEnvelopeSchema.safeParse(JSON.parse(rawBody));
    } catch {
      return null;
    }
  })();
  if (parsed === null || !parsed.success) {
    store.record({ ...base, signature: 'valid', outcome: 'rejected' });
    return { status: 400, holdMs: 0 };
  }
  const e = parsed.data;
  const idHeader = headers[EVENT_ID_HEADER];
  const meta = {
    ...base,
    eventId: e.eventId,
    type: e.type,
    stream: e.stream,
    version: e.version,
    data: e.data,
    signature: 'valid' as const,
  };
  if (typeof idHeader === 'string' && idHeader !== e.eventId) {
    store.record({ ...meta, outcome: 'rejected' });
    return { status: 400, holdMs: 0 };
  }
  const fault = webhookFault(store.nextDelivery(), chaos.enabled, chaos.failEvery);
  if (fault === 'error500') {
    store.record({ ...meta, outcome: 'fault_500' });
    return { status: 500, holdMs: 0 };
  }
  if (fault === 'timeout') {
    store.record({ ...meta, outcome: 'fault_timeout' });
    return { status: 504, holdMs: chaos.timeoutHoldMs };
  }
  store.record({ ...meta, outcome: store.accept(shopCode, e.eventId, e.stream, e.version, e.data) });
  return { status: 200, holdMs: 0 };
};
