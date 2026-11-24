// Express middlewares that run before Nest routing: request id, real client IP, the per-IP
// limit, content-type and body parsing. They answer in the shared error format themselves.
import { randomUUID } from 'node:crypto';
import express, { type NextFunction, type Request, type RequestHandler, type Response } from 'express';
import { httpStatusFor, type ErrorCode } from '@ff/shared/errors';
import { ipBucket, resolveClientIp, type TrustedProxies } from './client-ip';
import { type RateLimiter } from './rate-limit/limiter';

type Req = Request & { requestId?: string; clientIp?: string };

export const sendError = (req: Req, res: Response, code: ErrorCode, message: string): void => {
  res.status(httpStatusFor(code)).json({ error: { code, message, requestId: req.requestId ?? 'unknown' } });
};

export const requestContext =
  (trusted: TrustedProxies): RequestHandler =>
  (req: Req, res, next) => {
    req.requestId = randomUUID();
    req.clientIp = resolveClientIp(req.socket.remoteAddress, req.headers['x-real-ip'], trusted);
    res.setHeader('X-Request-Id', req.requestId);
    next();
  };

export const ipRateLimit =
  (limiter: RateLimiter, limit: number, enabled: boolean): RequestHandler =>
  (req: Req, res, next) => {
    if (!enabled) return next();
    limiter
      .consume('ip', ipBucket(req.clientIp ?? 'unknown'), limit)
      .then((d) => {
        if (d.allowed) return next();
        res.setHeader('Retry-After', String(Math.ceil(d.retryAfterMs / 1000)));
        sendError(req, res, 'RATE_LIMITED', 'too many requests');
      })
      .catch(next);
  };

const BODY_METHODS = new Set(['POST', 'PUT', 'PATCH']);

/** Bodies must be JSON; anything else is 415 (no silent coercion of form or text bodies). */
export const requireJson: RequestHandler = (req: Req, res, next) => {
  const hasBody =
    Number(req.headers['content-length'] ?? 0) > 0 || req.headers['transfer-encoding'] !== undefined;
  if (!BODY_METHODS.has(req.method) || !hasBody || req.is('application/json') === 'application/json')
    return next();
  sendError(req, res, 'UNSUPPORTED_MEDIA_TYPE', 'request body must be application/json');
};

const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/** JSON body parser with a size limit; prototype-pollution keys are refused at parse time. */
export const jsonBody = (limitBytes: number): RequestHandler => {
  const parse = express.json({
    limit: limitBytes,
    strict: true,
    reviver: (key: string, value: unknown) => {
      if (FORBIDDEN_KEYS.has(key)) throw new SyntaxError(`forbidden key "${key}"`);
      return value;
    },
  });
  return (req: Req, res: Response, next: NextFunction) =>
    parse(req, res, (err?: unknown) => {
      if (err === undefined || err === null) return next();
      const type = (err as { type?: string }).type;
      if (type === 'entity.too.large')
        return sendError(req, res, 'PAYLOAD_TOO_LARGE', 'request body too large');
      if (type === 'charset.unsupported' || type === 'encoding.unsupported') {
        return sendError(req, res, 'UNSUPPORTED_MEDIA_TYPE', 'unsupported body encoding');
      }
      return sendError(req, res, 'MALFORMED_JSON', 'request body is not valid JSON');
    });
};
