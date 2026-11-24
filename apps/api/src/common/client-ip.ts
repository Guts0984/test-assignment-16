// Real client IP (CLAUDE.md "Rate limiting"): X-Real-IP is honoured only when the TCP peer is a
// trusted proxy (nginx). Spoofed headers from anyone else are ignored.
import { BlockList, isIP } from 'node:net';

export type TrustedProxies = { readonly check: (ip: string) => boolean };

const stripMapped = (ip: string): string => (/^::ffff:\d+\.\d+\.\d+\.\d+$/i.test(ip) ? ip.slice(7) : ip);

export const parseTrustedProxies = (csv: string): TrustedProxies => {
  const list = new BlockList();
  const entries = csv
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  for (const e of entries) {
    const [addr = '', bits] = e.split('/');
    const family = isIP(addr);
    if (family === 0) throw new Error(`invalid trusted proxy "${e}"`);
    const type = family === 4 ? 'ipv4' : 'ipv6';
    const prefix = bits === undefined ? (family === 4 ? 32 : 128) : Number(bits);
    if (!Number.isInteger(prefix) || prefix < 0 || prefix > (family === 4 ? 32 : 128)) {
      throw new Error(`invalid prefix in "${e}"`);
    }
    list.addSubnet(addr, prefix, type);
  }
  return {
    check: (ip) => {
      const n = stripMapped(ip);
      const f = isIP(n);
      return entries.length > 0 && f !== 0 && list.check(n, f === 4 ? 'ipv4' : 'ipv6');
    },
  };
};

const expandIpv6 = (ip: string): readonly string[] => {
  const [head = '', tail = ''] = ip.split('::');
  const h = head === '' ? [] : head.split(':');
  const t = ip.includes('::') ? (tail === '' ? [] : tail.split(':')) : [];
  const fill = ip.includes('::') ? Array.from({ length: 8 - h.length - t.length }, () => '0') : [];
  return [...h, ...fill, ...t].map((x) => x.toLowerCase().padStart(4, '0'));
};

/**
 * Bucket key for an address: IPv4 as is (IPv4-mapped IPv6 folded to IPv4), IPv6 by /64, since
 * one host usually owns a whole /64 and could otherwise rotate addresses to dodge the limit.
 */
export const ipBucket = (ip: string): string => {
  const n = stripMapped(ip.replace(/%.*$/, ''));
  if (isIP(n) === 4) return n;
  if (isIP(n) === 6) return `${expandIpv6(n).slice(0, 4).join(':')}::/64`;
  return 'unknown';
};

export const resolveClientIp = (
  remoteAddress: string | undefined,
  realIpHeader: string | string[] | undefined,
  trusted: TrustedProxies,
): string => {
  const peer = stripMapped(remoteAddress ?? '');
  if (peer === '' || !trusted.check(peer)) return peer === '' ? 'unknown' : peer;
  const header = Array.isArray(realIpHeader) ? undefined : realIpHeader?.trim();
  return header !== undefined && isIP(stripMapped(header)) !== 0 ? stripMapped(header) : peer;
};
