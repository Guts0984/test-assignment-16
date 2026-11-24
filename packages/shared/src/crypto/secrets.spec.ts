import { describe, expect, it } from 'vitest';
import {
  apiKeyMatches,
  decryptSecret,
  deriveSeedApiKey,
  encryptSecret,
  generateApiKey,
  hashApiKey,
  parseApiKey,
} from './secrets';

const KEY = Buffer.alloc(32, 7).toString('base64');

describe('api keys', () => {
  it('generated and derived keys parse; malformed, truncated and padded ones do not', () => {
    const k = generateApiKey();
    expect(parseApiKey(k)?.key).toBe(k);
    const d = deriveSeedApiKey('salt', 'SHOP1');
    expect(parseApiKey(d)?.prefix).toBe(d.slice(3, 11));
    expect(deriveSeedApiKey('salt', 'SHOP1')).toBe(d);
    expect(deriveSeedApiKey('salt', 'SHOP2')).not.toBe(d);
    expect(parseApiKey(d.slice(0, -1))).toBeNull();
    expect(parseApiKey(`${d}x`)).toBeNull();
    expect(parseApiKey(` ${d}`)).toBeNull();
    expect(parseApiKey(undefined)).toBeNull();
    expect(parseApiKey("fk_00000000_' OR 1=1 --xxxxxxxxxxxxxxxxxx")).toBeNull();
  });
  it('hash comparison accepts only the exact key and pepper', () => {
    const k = generateApiKey();
    const h = hashApiKey('pepper', k);
    expect(apiKeyMatches('pepper', k, h)).toBe(true);
    expect(apiKeyMatches('other', k, h)).toBe(false);
    expect(apiKeyMatches('pepper', generateApiKey(), h)).toBe(false);
    expect(apiKeyMatches('pepper', k, 'abc')).toBe(false);
  });
});

describe('secret box', () => {
  it('round-trips and detects tampering', () => {
    const boxed = encryptSecret(KEY, 'whsec');
    expect(decryptSecret(KEY, boxed)).toBe('whsec');
    expect(encryptSecret(KEY, 'whsec')).not.toBe(boxed);
    const raw = Buffer.from(boxed, 'base64');
    raw[raw.length - 1] = (raw[raw.length - 1] ?? 0) ^ 1;
    expect(() => decryptSecret(KEY, raw.toString('base64'))).toThrow();
    expect(() => decryptSecret(Buffer.alloc(32, 8).toString('base64'), boxed)).toThrow();
  });
  it('rejects keys of the wrong size', () => {
    expect(() => encryptSecret(Buffer.alloc(16).toString('base64'), 'x')).toThrow();
  });
});
