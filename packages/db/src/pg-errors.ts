// Maps Prisma / Postgres errors to SQLSTATE codes so callers can react to constraint failures.
import { Prisma } from '@prisma/client';

export const SQLSTATE = {
  uniqueViolation: '23505',
  checkViolation: '23514',
  foreignKeyViolation: '23503',
  deadlock: '40P01',
  serialization: '40001',
  lockNotAvailable: '55P03',
} as const;

const PRISMA_TO_SQLSTATE: Readonly<Record<string, string>> = {
  P2002: SQLSTATE.uniqueViolation,
  P2003: SQLSTATE.foreignKeyViolation,
  P2034: SQLSTATE.serialization,
};

const fromMessage = (msg: string): string | null => {
  const m = /(?:code|SqlState)[:(]\s*`?"?([0-9A-Z]{5})/i.exec(msg) ?? /\b(23505|23514|23503|40P01|40001|55P03)\b/.exec(msg);
  return m?.[1] ?? null;
};

export const pgCode = (e: unknown): string | null => {
  if (e instanceof Prisma.PrismaClientKnownRequestError) {
    const meta = e.meta as { code?: unknown } | undefined;
    if (typeof meta?.code === 'string' && /^[0-9A-Z]{5}$/.test(meta.code)) return meta.code;
    return PRISMA_TO_SQLSTATE[e.code] ?? fromMessage(e.message);
  }
  if (e instanceof Prisma.PrismaClientUnknownRequestError) return fromMessage(e.message);
  return null;
};

/** Name of the violated constraint, when Postgres reports it. */
export const pgConstraint = (e: unknown): string | null => {
  if (!(e instanceof Error)) return null;
  const meta = (e as { meta?: { target?: unknown; constraint?: unknown } }).meta;
  if (typeof meta?.constraint === 'string') return meta.constraint;
  if (Array.isArray(meta?.target)) return meta.target.join(',');
  if (typeof meta?.target === 'string') return meta.target;
  const m = /constraint "?([a-z0-9_]+)"?/i.exec(e.message);
  return m?.[1] ?? null;
};

export const isRetryable = (e: unknown): boolean => {
  const c = pgCode(e);
  return c === SQLSTATE.deadlock || c === SQLSTATE.serialization || c === SQLSTATE.lockNotAvailable;
};
