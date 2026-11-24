import { describe, expect, it } from 'vitest';
import { ipBucket, parseTrustedProxies, resolveClientIp } from './client-ip';

const nginx = parseTrustedProxies('172.31.116.10/32, 127.0.0.1');

describe('resolveClientIp', () => {
  it('ignores X-Real-IP from an untrusted peer (spoofing)', () => {
    expect(resolveClientIp('203.0.113.7', '1.2.3.4', nginx)).toBe('203.0.113.7');
  });
  it('honours X-Real-IP from nginx', () => {
    expect(resolveClientIp('172.31.116.10', '198.51.100.9', nginx)).toBe('198.51.100.9');
    expect(resolveClientIp('::ffff:172.31.116.10', '198.51.100.9', nginx)).toBe('198.51.100.9');
  });
  it('falls back to the peer when the trusted header is missing, invalid or duplicated', () => {
    expect(resolveClientIp('127.0.0.1', undefined, nginx)).toBe('127.0.0.1');
    expect(resolveClientIp('127.0.0.1', '1.2.3.4, 5.6.7.8', nginx)).toBe('127.0.0.1');
    expect(resolveClientIp('127.0.0.1', 'evil\r\nX: y', nginx)).toBe('127.0.0.1');
    expect(resolveClientIp('127.0.0.1', ['1.1.1.1', '2.2.2.2'], nginx)).toBe('127.0.0.1');
  });
  it('trusts nobody when the list is empty', () => {
    expect(resolveClientIp('127.0.0.1', '9.9.9.9', parseTrustedProxies(''))).toBe('127.0.0.1');
  });
  it('rejects malformed proxy lists', () => {
    expect(() => parseTrustedProxies('nope')).toThrow();
    expect(() => parseTrustedProxies('10.0.0.0/33')).toThrow();
  });
});

describe('ipBucket', () => {
  it('folds IPv4-mapped IPv6 into the IPv4 bucket', () => {
    expect(ipBucket('::ffff:10.1.2.3')).toBe(ipBucket('10.1.2.3'));
  });
  it('groups IPv6 by /64', () => {
    expect(ipBucket('2001:db8:1:2:aaaa::1')).toBe(ipBucket('2001:db8:1:2:ffff:ffff:ffff:ffff'));
    expect(ipBucket('2001:db8:1:3::1')).not.toBe(ipBucket('2001:db8:1:2::1'));
    expect(ipBucket('2001:DB8:1:2::1%eth0')).toBe('2001:0db8:0001:0002::/64');
  });
  it('unknown input never crashes', () => expect(ipBucket('garbage')).toBe('unknown'));
});
