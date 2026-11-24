// Access tokens (HS256 JWT, short-lived) and opaque refresh tokens. Time comes from the injected clock.
import { createHash, randomBytes } from 'node:crypto';
import jwt from 'jsonwebtoken';
import { z } from 'zod';

export const accessClaimsSchema = z
  .object({
    sub: z.string().uuid(),
    typ: z.enum(['staff', 'shop_user']),
    fam: z.string().uuid(),
    iat: z.number().int(),
    exp: z.number().int(),
  })
  .strict();
export type AccessClaims = z.infer<typeof accessClaimsSchema>;

const seconds = (d: Date): number => Math.floor(d.getTime() / 1000);

export const signAccessToken = (
  claims: Pick<AccessClaims, 'sub' | 'typ' | 'fam'>,
  secret: string,
  ttlSec: number,
  now: Date,
): string =>
  jwt.sign({ ...claims, iat: seconds(now), exp: seconds(now) + ttlSec }, secret, { algorithm: 'HS256' });

/** Only HS256 with our secret; alg none, other algorithms, tampering, expiry and missing claims fail. */
export const verifyAccessToken = (token: string, secret: string, now: Date): AccessClaims | null => {
  try {
    const decoded = jwt.verify(token, secret, { algorithms: ['HS256'], clockTimestamp: seconds(now) });
    const parsed = accessClaimsSchema.safeParse(decoded);
    return parsed.success && parsed.data.iat <= seconds(now) + 5 ? parsed.data : null;
  } catch {
    return null;
  }
};

export const newRefreshToken = (): string => randomBytes(32).toString('base64url');
export const hashToken = (t: string): string => createHash('sha256').update(t).digest('hex');
export const looksLikeJwt = (t: string): boolean =>
  /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*$/.test(t);
