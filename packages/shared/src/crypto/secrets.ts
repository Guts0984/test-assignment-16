// Secret handling shared by api, worker and seed: shop API keys and per-shop webhook secrets.
// Pure functions over node:crypto (no IO).
import { createCipheriv, createDecipheriv, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const KEY_RE = /^fk_([0-9a-f]{8})_([A-Za-z0-9]{32})$/;

export type ParsedApiKey = { readonly prefix: string; readonly key: string };

/** A new random key: `fk_<8 hex prefix>_<32 alnum secret>`. Shown once, stored hashed. */
export const generateApiKey = (): string => {
  const prefix = randomBytes(4).toString('hex');
  const secret = randomBytes(24).toString('base64url').replace(/[-_]/g, 'x').slice(0, 32);
  return `fk_${prefix}_${secret}`;
};

/** Deterministic demo key for a seeded shop, so the README can list it. */
export const deriveSeedApiKey = (salt: string, shopCode: string): string => {
  const h = createHmac('sha256', salt).update(`api-key:${shopCode}`).digest();
  const prefix = h.subarray(0, 4).toString('hex');
  const secret = h.subarray(4).toString('base64url').replace(/[-_]/g, 'x').slice(0, 32).padEnd(32, 'x');
  return `fk_${prefix}_${secret}`;
};

export const parseApiKey = (raw: string | undefined): ParsedApiKey | null => {
  const m = KEY_RE.exec(raw ?? '');
  return m === null || m[1] === undefined ? null : { prefix: m[1], key: raw ?? '' };
};

export const hashApiKey = (pepper: string, key: string): string =>
  createHmac('sha256', pepper).update(key).digest('hex');

export const apiKeyMatches = (pepper: string, key: string, storedHash: string): boolean => {
  const a = Buffer.from(hashApiKey(pepper, key), 'hex');
  const b = Buffer.from(storedHash, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
};

export const generateWebhookSecret = (): string => randomBytes(32).toString('hex');
export const deriveSeedWebhookSecret = (salt: string, shopCode: string): string =>
  createHmac('sha256', salt).update(`webhook:${shopCode}`).digest('hex');

const keyFrom = (keyB64: string): Buffer => {
  const k = Buffer.from(keyB64, 'base64');
  if (k.length !== 32) throw new Error('encryption key must be 32 bytes (base64)');
  return k;
};

/** AES-256-GCM: base64(iv(12) | tag(16) | ciphertext). */
export const encryptSecret = (keyB64: string, plaintext: string): string => {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', keyFrom(keyB64), iv);
  const ct = Buffer.concat([c.update(plaintext, 'utf8'), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64');
};

export const decryptSecret = (keyB64: string, boxed: string): string => {
  const raw = Buffer.from(boxed, 'base64');
  const d = createDecipheriv('aes-256-gcm', keyFrom(keyB64), raw.subarray(0, 12));
  d.setAuthTag(raw.subarray(12, 28));
  return Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString('utf8');
};
