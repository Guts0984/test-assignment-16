// Global guard: every route declares its access rule; principals are resolved and checked here.
import { type CanActivate, type ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { type Request } from 'express';
import { AuthService } from '../../modules/auth/auth.service';
import { httpError } from '../errors';
import { ACCESS_KEY, type AccessRule } from './access.decorator';
import { hasAnyRole, hasRoleAt, type Principal } from './principal';

type Req = Request & { principal?: Principal };

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly auth: AuthService,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    if (ctx.getType() !== 'http') return true;
    const rule = this.reflector.getAllAndOverride<AccessRule | undefined>(ACCESS_KEY, [
      ctx.getHandler(),
      ctx.getClass(),
    ]);
    // Secure by default: a route without a declared rule is closed.
    if (rule === undefined) throw httpError('FORBIDDEN', 'route has no access rule');
    if (rule.public === true) return true;
    const req = ctx.switchToHttp().getRequest<Req>();
    const resolved = await this.auth.resolveBearer(req.headers.authorization);
    if (!resolved.ok)
      throw httpError(
        resolved.error.code === 'UNAUTHENTICATED' ? 'UNAUTHENTICATED' : 'TOKEN_INVALID',
        resolved.error.message,
      );
    const p = resolved.value;
    if (!rule.principals.includes(p.kind))
      throw httpError('FORBIDDEN', 'not allowed for this kind of caller');
    if (p.kind === 'staff' && rule.roles !== undefined && rule.roles.length > 0) {
      const param = rule.warehouseParam === undefined ? undefined : req.params[rule.warehouseParam];
      const allowed =
        param === undefined
          ? hasAnyRole(p, rule.roles)
          : typeof param === 'string' && hasRoleAt(p, param, rule.roles);
      if (!allowed) throw httpError('FORBIDDEN', 'missing role for this warehouse');
    }
    req.principal = p;
    return true;
  }
}
