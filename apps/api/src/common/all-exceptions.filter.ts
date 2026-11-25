// One error format for every endpoint and every failure (invariant 12): never a bare 500,
// a stack trace, SQL or an internal path.
import { type ArgumentsHost, Catch, type ExceptionFilter, HttpException, Logger } from '@nestjs/common';
import { type Request, type Response } from 'express';
import { ZodValidationException } from 'nestjs-zod';
import { type ZodError } from 'zod';
import { pgCode, SQLSTATE } from '@ff/db/pg-errors';
import { httpStatusFor, type ErrorCode, type FieldError } from '@ff/shared/errors';
import { isErrorPayload } from './errors';

const zodFields = (e: ZodError): FieldError[] =>
  e.issues
    .slice(0, 50)
    .map((i) => ({ path: i.path.join('.') || '(root)', code: i.code, message: i.message }));

type Mapped = { code: ErrorCode; message: string; fields?: FieldError[]; details?: Record<string, unknown> };

const fromHttp = (e: HttpException): Mapped => {
  const status = e.getStatus();
  const body = e.getResponse();
  if (isErrorPayload(body)) {
    const { __ff: _ignored, ...rest } = body;
    return rest as Mapped;
  }
  if (status === 404) return { code: 'NOT_FOUND', message: 'route or resource not found' };
  if (status === 405) return { code: 'METHOD_NOT_ALLOWED', message: 'method not allowed' };
  if (status === 413) return { code: 'PAYLOAD_TOO_LARGE', message: 'request body too large' };
  if (status === 401) return { code: 'UNAUTHENTICATED', message: 'authentication required' };
  if (status === 403) return { code: 'FORBIDDEN', message: 'forbidden' };
  if (status === 429) return { code: 'RATE_LIMITED', message: 'too many requests' };
  if (status === 400) return { code: 'VALIDATION_FAILED', message: 'invalid request' };
  return { code: 'UNEXPECTED', message: 'unexpected error' };
};

/** body-parser errors carry `type` and `status`. */
const fromParser = (e: unknown): Mapped | null => {
  const t = (e as { type?: unknown }).type;
  if (t === 'entity.too.large') return { code: 'PAYLOAD_TOO_LARGE', message: 'request body too large' };
  if (t === 'entity.parse.failed')
    return { code: 'MALFORMED_JSON', message: 'request body is not valid JSON' };
  if (t === 'encoding.unsupported' || t === 'charset.unsupported') {
    return { code: 'UNSUPPORTED_MEDIA_TYPE', message: 'unsupported encoding' };
  }
  if (t === 'request.aborted' || t === 'request.size.invalid')
    return { code: 'VALIDATION_FAILED', message: 'bad request body' };
  return null;
};

/** Prisma / driver errors that mean "the database cannot be reached right now". */
const isDatabaseDown = (e: unknown): boolean => {
  const code = (e as { code?: unknown } | null)?.code;
  const name = (e as { name?: unknown } | null)?.name;
  return (
    name === 'PrismaClientInitializationError' ||
    (typeof code === 'string' &&
      ['P1001', 'P1002', 'P1008', 'P1017', 'P2024', 'ECONNREFUSED', 'ECONNRESET'].includes(code)) ||
    (typeof code === 'string' && code.startsWith('08')) ||
    code === SQLSTATE_ADMIN_SHUTDOWN
  );
};
const SQLSTATE_ADMIN_SHUTDOWN = '57P01';

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger('errors');

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const res = ctx.getResponse<Response>();
    const req = ctx.getRequest<Request & { requestId?: string }>();
    const mapped = this.map(exception);
    if (mapped.code === 'UNEXPECTED') {
      this.logger.error(
        `unexpected error on ${req.method} ${req.path}: ${exception instanceof Error ? exception.message : String(exception)}`,
      );
    }
    if (res.headersSent) return;
    res
      .status(httpStatusFor(mapped.code))
      .json({ error: { ...mapped, requestId: req.requestId ?? 'unknown' } });
  }

  private map(e: unknown): Mapped {
    if (e instanceof ZodValidationException) {
      return {
        code: 'VALIDATION_FAILED',
        message: 'request validation failed',
        fields: zodFields(e.getZodError() as ZodError),
      };
    }
    if (e instanceof HttpException) return fromHttp(e);
    const parser = fromParser(e);
    if (parser !== null) return parser;
    const pg = pgCode(e);
    if (pg === SQLSTATE.uniqueViolation)
      return { code: 'CONFLICT', message: 'a record with these values already exists' };
    if (pg === SQLSTATE.checkViolation)
      return { code: 'INSUFFICIENT_STOCK', message: 'the change would break a stock rule' };
    if (pg === SQLSTATE.deadlock || pg === SQLSTATE.serialization) {
      return { code: 'CONFLICT', message: 'concurrent update, please retry' };
    }
    if (isDatabaseDown(e) || (pg !== null && isDatabaseDown({ code: pg })))
      return { code: 'UNAVAILABLE', message: 'the service is temporarily unavailable' };
    return { code: 'UNEXPECTED', message: 'unexpected error' };
  }
}
