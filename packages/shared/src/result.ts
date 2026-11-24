// Expected failures are values, not exceptions (CLAUDE.md "Paradigm").
import { type ErrorCode } from './errors';

export type Ok<T> = { readonly ok: true; readonly value: T };
export type Err<E> = { readonly ok: false; readonly error: E };
export type Result<T, E = DomainError> = Ok<T> | Err<E>;

export type DomainError = {
  readonly code: ErrorCode;
  readonly message: string;
  readonly details?: Readonly<Record<string, unknown>>;
};

export const ok = <T>(value: T): Ok<T> => ({ ok: true, value });
export const err = <E>(error: E): Err<E> => ({ ok: false, error });

export const fail = (
  code: ErrorCode,
  message: string,
  details?: Readonly<Record<string, unknown>>,
): Err<DomainError> => err(details === undefined ? { code, message } : { code, message, details });

export const map = <T, U, E>(r: Result<T, E>, f: (v: T) => U): Result<U, E> => (r.ok ? ok(f(r.value)) : r);

export const flatMap = <T, U, E>(r: Result<T, E>, f: (v: T) => Result<U, E>): Result<U, E> =>
  r.ok ? f(r.value) : r;

/** Collects results; returns the first error or all values. */
export const all = <T, E>(rs: readonly Result<T, E>[]): Result<readonly T[], E> => {
  const firstErr = rs.find((r): r is Err<E> => !r.ok);
  return firstErr ?? ok(rs.map((r) => (r as Ok<T>).value));
};
