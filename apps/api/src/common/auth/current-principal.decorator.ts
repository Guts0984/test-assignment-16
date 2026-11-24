import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import { type Principal } from './principal';
import { httpError } from '../errors';

/** The authenticated caller (set by AuthGuard). */
export const CurrentPrincipal = createParamDecorator((_: unknown, ctx: ExecutionContext): Principal => {
  const p = ctx.switchToHttp().getRequest<{ principal?: Principal }>().principal;
  if (p === undefined) throw httpError('UNAUTHENTICATED', 'authentication required');
  return p;
});

/** The resolved real client IP (set by the request middleware). */
export const ClientIp = createParamDecorator(
  (_: unknown, ctx: ExecutionContext): string =>
    ctx.switchToHttp().getRequest<{ clientIp?: string }>().clientIp ?? 'unknown',
);
