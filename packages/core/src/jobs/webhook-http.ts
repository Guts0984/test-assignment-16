// Outbound webhook HTTP: no redirects, hard timeout, header values sanitised, and the destination
// is validated at connect time (so a DNS answer pointing at a private address is refused).
import { type LookupFunction } from 'node:net';
import http from 'node:http';
import https from 'node:https';
import dns from 'node:dns';
import { isIP } from 'node:net';

export type HttpOutcome =
  { readonly status: number } | { readonly error: 'timeout' | 'blocked' | 'network' | 'redirect' };

const PRIVATE_V4 = [
  /^10\./,
  /^127\./,
  /^169\.254\./,
  /^192\.168\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^0\./,
  /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./,
];

export const isPrivateAddress = (ip: string): boolean => {
  const v = ip.replace(/^::ffff:/i, '');
  if (isIP(v) === 4) return PRIVATE_V4.some((r) => r.test(v));
  const l = v.toLowerCase();
  return l === '::1' || l === '::' || l.startsWith('fe80') || l.startsWith('fc') || l.startsWith('fd');
};

/**
 * DNS lookup that refuses private answers. Node may ask for one address or for all of them
 * (autoSelectFamily), so both callback shapes are supported. A name that resolves to any private
 * address is refused as a whole: a rebinding answer cannot sneak one in.
 */
const guardedLookup =
  (allowPrivate: boolean): LookupFunction =>
  (hostname, options, cb) => {
    dns.lookup(hostname, { ...options, all: true }, (err, addresses) => {
      if (err) return cb(err, '', 4);
      const list = Array.isArray(addresses) ? addresses : [];
      if (list.length === 0) return cb(new Error('no address'), '', 4);
      if (!allowPrivate && list.some((a) => isPrivateAddress(a.address)))
        return cb(new Error('blocked address'), '', 4);
      if (options.all === true)
        return (cb as unknown as (e: null, a: dns.LookupAddress[]) => void)(null, list);
      const first = list[0];
      return cb(null, first?.address ?? '', first?.family ?? 4);
    });
  };

const safeHeader = (v: string): string =>
  [...v].filter((c) => !['\r', '\n', String.fromCharCode(0)].includes(c)).join('');

export const postWebhook = (
  url: string,
  body: string,
  headers: Readonly<Record<string, string>>,
  o: { readonly timeoutMs: number; readonly allowPrivate: boolean },
): Promise<HttpOutcome> =>
  new Promise((resolve) => {
    const u = (() => {
      try {
        return new URL(url);
      } catch {
        return null;
      }
    })();
    if (u === null || (u.protocol !== 'http:' && u.protocol !== 'https:'))
      return resolve({ error: 'blocked' });
    // Node skips the DNS lookup for literal IPs, so they are checked here.
    const host = u.hostname.replace(/^\[|\]$/g, '');
    if (isIP(host) !== 0 && !o.allowPrivate && isPrivateAddress(host)) return resolve({ error: 'blocked' });
    const lib = u.protocol === 'https:' ? https : http;
    const clean = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k, safeHeader(v)]));
    const req = lib.request(
      u,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': String(Buffer.byteLength(body)),
          ...clean,
        },
        lookup: guardedLookup(o.allowPrivate),
        timeout: o.timeoutMs,
        agent: false,
      },
      (res) => {
        res.resume();
        res.on('end', () => {
          const s = res.statusCode ?? 0;
          resolve(s >= 300 && s < 400 ? { error: 'redirect' } : { status: s });
        });
        res.on('error', () => resolve({ error: 'network' }));
      },
    );
    const done = (e: 'timeout' | 'blocked' | 'network') => {
      req.destroy();
      resolve({ error: e });
    };
    req.on('timeout', () => done('timeout'));
    req.on('error', (e) => done(e.message.includes('blocked address') ? 'blocked' : 'network'));
    req.end(body);
  });
