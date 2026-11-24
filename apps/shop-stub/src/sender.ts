// Sends demo orders to the fulfillment API. In chaos mode each order goes to both api copies at
// the same moment, and some orders are cancelled right after they are created.
import { seededRandom, type ChaosSettings } from './chaos';
import { type ShopCreds } from './store';

export type SendResult = {
  readonly externalNumber: string;
  readonly responses: readonly {
    readonly target: string;
    readonly status: number;
    readonly orderId: string | null;
  }[];
  readonly cancelled: boolean;
};

export type SenderDeps = {
  readonly fetch: typeof fetch;
  readonly apiUrl: string;
  readonly apiAUrl: string;
  readonly apiBUrl: string;
  readonly chaos: () => ChaosSettings;
  readonly seed: number;
};

type Line = { sku: string; qty: number };

const NAMES = [
  'Olena Kovalenko',
  'Jan Nowak',
  'Iryna Melnyk',
  'Piotr Wojcik',
  'Anna Boyko',
  'Ewa Zielinska',
] as const;

export const createSender = (d: SenderDeps) => {
  const rnd = seededRandom(d.seed);
  const skuCache = new Map<string, readonly string[]>();
  const counter = { n: 0 };

  const call = async (base: string, shop: ShopCreds, method: string, path: string, body?: unknown) => {
    const res = await d.fetch(`${base}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${shop.apiKey}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const json = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    return { status: res.status, json };
  };

  const skusOf = async (shop: ShopCreds): Promise<readonly string[]> => {
    const cached = skuCache.get(shop.code);
    if (cached !== undefined && cached.length > 0) return cached;
    const r = await call(d.apiUrl, shop, 'GET', '/shop/v1/skus?limit=200');
    const codes = ((r.json?.items as { code: string }[] | undefined) ?? []).map((s) => s.code);
    skuCache.set(shop.code, codes);
    return codes;
  };

  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)] as T;

  const buildOrder = async (
    shop: ShopCreds,
    o: { lines?: readonly Line[]; express?: boolean; externalNumber?: string },
  ) => {
    counter.n += 1;
    const skus = o.lines === undefined ? await skusOf(shop) : [];
    const lines =
      o.lines ??
      [...new Set(Array.from({ length: 1 + Math.floor(rnd() * 2) }, () => pick(skus)))].map((sku) => ({
        sku,
        qty: 1 + Math.floor(rnd() * 2),
      }));
    return {
      externalNumber: o.externalNumber ?? `STUB-${shop.code}-${Date.now().toString(36)}-${counter.n}`,
      deliveryMethod: (o.express ?? rnd() < 0.2) ? 'express' : 'standard',
      address: {
        name: pick(NAMES),
        line1: `${1 + Math.floor(rnd() * 200)} Main St`,
        city: 'Lviv',
        postalCode: '79000',
        country: 'UA',
      },
      lines,
    };
  };

  const sendOne = async (
    shop: ShopCreds,
    o: { lines?: readonly Line[]; express?: boolean; externalNumber?: string },
  ): Promise<SendResult> => {
    const chaos = d.chaos();
    const body = await buildOrder(shop, o);
    const targets = chaos.enabled ? [d.apiAUrl, d.apiBUrl] : [d.apiUrl];
    const responses = await Promise.all(
      targets.map(async (t) => {
        const r = await call(t, shop, 'POST', '/shop/v1/orders', body).catch(() => ({
          status: 0,
          json: null,
        }));
        return {
          target: t,
          status: r.status,
          orderId: typeof r.json?.orderId === 'string' ? r.json.orderId : null,
        };
      }),
    );
    const orderId = responses.find((r) => r.orderId !== null)?.orderId ?? null;
    const cancel = chaos.enabled && orderId !== null && rnd() < chaos.cancelRate;
    if (cancel) await call(d.apiUrl, shop, 'POST', `/shop/v1/orders/${orderId}/cancel`).catch(() => null);
    return { externalNumber: body.externalNumber, responses, cancelled: cancel };
  };

  return {
    send: async (
      shop: ShopCreds,
      count: number,
      o: { lines?: readonly Line[]; express?: boolean; externalNumber?: string } = {},
    ) => {
      const results: SendResult[] = [];
      for (let i = 0; i < count; i += 1)
        results.push(await sendOne(shop, count === 1 ? o : { ...o, externalNumber: undefined }));
      return results;
    },
    cancel: (shop: ShopCreds, orderId: string) =>
      call(d.apiUrl, shop, 'POST', `/shop/v1/orders/${orderId}/cancel`),
    forgetSkus: (code: string) => void skuCache.delete(code),
  };
};

export type Sender = ReturnType<typeof createSender>;
