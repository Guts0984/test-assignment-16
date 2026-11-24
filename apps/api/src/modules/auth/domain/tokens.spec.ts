import jwt from 'jsonwebtoken';
import { describe, expect, it } from 'vitest';
import { signAccessToken, verifyAccessToken } from './tokens';

const SECRET = 'x'.repeat(40);
const now = new Date('2026-11-24T10:00:00Z');
const claims = {
  sub: '00000000-0000-4000-8000-000000000001',
  typ: 'staff' as const,
  fam: '00000000-0000-4000-8000-000000000002',
};

describe('access tokens', () => {
  it('round-trips', () => {
    expect(verifyAccessToken(signAccessToken(claims, SECRET, 900, now), SECRET, now)?.sub).toBe(claims.sub);
  });
  it('rejects expired (at exp) and accepts one second before', () => {
    const t = signAccessToken(claims, SECRET, 900, now);
    expect(verifyAccessToken(t, SECRET, new Date(now.getTime() + 899_000))).not.toBeNull();
    expect(verifyAccessToken(t, SECRET, new Date(now.getTime() + 900_000))).toBeNull();
  });
  it('rejects a token issued in the future (not yet valid)', () => {
    expect(
      verifyAccessToken(signAccessToken(claims, SECRET, 900, new Date(now.getTime() + 60_000)), SECRET, now),
    ).toBeNull();
  });
  it('rejects wrong secret, tampered payload, alg none and other algorithms', () => {
    const t = signAccessToken(claims, SECRET, 900, now);
    expect(verifyAccessToken(t, 'y'.repeat(40), now)).toBeNull();
    const [h, , s] = t.split('.');
    const forged = Buffer.from(
      JSON.stringify({ ...claims, sub: '00000000-0000-4000-8000-000000000009', iat: 0, exp: 9e9 }),
    ).toString('base64url');
    expect(verifyAccessToken(`${h}.${forged}.${s}`, SECRET, now)).toBeNull();
    const none = jwt.sign({ ...claims, iat: 1, exp: 9e9 }, '', { algorithm: 'none' });
    expect(verifyAccessToken(none, SECRET, now)).toBeNull();
    const hs512 = jwt.sign({ ...claims, iat: Math.floor(now.getTime() / 1000), exp: 9e9 }, SECRET, {
      algorithm: 'HS512',
    });
    expect(verifyAccessToken(hs512, SECRET, now)).toBeNull();
  });
  it('rejects missing or extra claims', () => {
    const iat = Math.floor(now.getTime() / 1000);
    const noFam = jwt.sign({ sub: claims.sub, typ: 'staff', iat, exp: iat + 60 }, SECRET, {
      algorithm: 'HS256',
    });
    expect(verifyAccessToken(noFam, SECRET, now)).toBeNull();
    const extra = jwt.sign({ ...claims, role: 'admin', iat, exp: iat + 60 }, SECRET, { algorithm: 'HS256' });
    expect(verifyAccessToken(extra, SECRET, now)).toBeNull();
  });
});
