// Per-account / per-key / per-staff limits (after authentication). The per-IP general limit runs
// earlier as middleware so floods never reach the database.
import { type CanActivate, type ExecutionContext, Inject, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { type Request, type Response } from 'express';
import { type ApiEnv } from '../../config/env';
import { ENV, LIMITER } from '../../infra/tokens';
import { RATE_LIMIT_KEY, type RateBucket } from '../auth/access.decorator';
import { type Principal } from '../auth/principal';
import { ipBucket } from '../client-ip';
import { httpError } from '../errors';
import { type LimitDecision, type RateLimiter } from './limiter';

type Req = Request & { principal?: Principal; clientIp?: string };

@Injectable()
export class RateLimitGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    @Inject(LIMITER) private readonly l: { limiter: RateLimiter },
    @Inject(ENV) private readonly env: ApiEnv,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    if (ctx.getType() !== 'http' || !this.env.RATE_LIMIT_ENABLED) return true;
    const req = ctx.switchToHttp().getRequest<Req>();
    const res = ctx.switchToHttp().getResponse<Response>();
    const ip = ipBucket(req.clientIp ?? 'unknown');
    const bucket = this.reflector.get<RateBucket | undefined>(RATE_LIMIT_KEY, ctx.getHandler());
    const checks: Array<[string, string, number]> = [];
    if (bucket === 'login') {
      checks.push(['login-ip', ip, this.env.RATE_LIMIT_LOGIN_PER_IP]);
      const email = (req.body as { email?: unknown } | undefined)?.email;
      if (typeof email === 'string')
        checks.push(['login-account', email.toLowerCase(), this.env.RATE_LIMIT_LOGIN_PER_ACCOUNT]);
    }
    const p = req.principal;
    if (p?.kind === 'api_key') {
      checks.push(['shop-key', p.id, this.env.RATE_LIMIT_SHOP_API_PER_KEY]);
      checks.push(['shop-ip', ip, this.env.RATE_LIMIT_SHOP_API_PER_IP]);
    }
    if (bucket === 'scan' && p?.kind === 'staff')
      checks.push(['scan', p.id, this.env.RATE_LIMIT_SCAN_PER_STAFF]);
    for (const [name, subject, limit] of checks) {
      const d = await this.l.limiter.consume(name, subject, limit);
      if (!d.allowed) throw rejected(res, d);
    }
    return true;
  }
}

export const rejected = (res: Response, d: LimitDecision) => {
  res.setHeader('Retry-After', String(Math.ceil(d.retryAfterMs / 1000)));
  res.setHeader('RateLimit-Limit', String(d.limit));
  res.setHeader('RateLimit-Remaining', '0');
  return httpError('RATE_LIMITED', 'too many requests', { details: { retryAfterMs: d.retryAfterMs } });
};
