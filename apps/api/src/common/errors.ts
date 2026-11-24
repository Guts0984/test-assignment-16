// Domain results to HTTP: every failure leaves the API in the shared error format.
import { HttpException } from '@nestjs/common';
import { httpStatusFor, type ErrorCode, type FieldError } from '@ff/shared/errors';
import { type DomainError, type Result } from '@ff/shared/result';

export type ErrorPayload = {
  readonly code: ErrorCode;
  readonly message: string;
  readonly fields?: readonly FieldError[];
  readonly details?: Readonly<Record<string, unknown>>;
};

export const httpError = (
  code: ErrorCode,
  message: string,
  extra: Partial<ErrorPayload> = {},
): HttpException => new HttpException({ __ff: true, code, message, ...extra }, httpStatusFor(code));

export const fromDomain = (e: DomainError): HttpException =>
  httpError(e.code, e.message, e.details === undefined ? {} : { details: e.details });

/** Returns the value or throws the mapped HTTP error (controllers only). */
export const unwrap = <T>(r: Result<T>): T => {
  if (r.ok) return r.value;
  throw fromDomain(r.error);
};

export const isErrorPayload = (v: unknown): v is ErrorPayload & { __ff: true } =>
  typeof v === 'object' && v !== null && (v as { __ff?: unknown }).__ff === true;
