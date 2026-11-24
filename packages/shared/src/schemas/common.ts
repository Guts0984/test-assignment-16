// Building blocks for every input schema. Objects are .strict() so extra fields
// (mass assignment: id, shopId, status, reserved, version, approvedBy...) are rejected.
import { z } from 'zod';
import { isValidCutoff, isValidTimeZone } from '../time/calendar';

/** True when the string has a C0 control character (other than tab, LF, CR) or DEL. */
const hasControlChars = (s: string): boolean =>
  [...s].some((ch) => {
    const c = ch.codePointAt(0) ?? 0;
    return (c < 0x20 && c !== 0x09 && c !== 0x0a && c !== 0x0d) || c === 0x7f;
  });

/** Free text: no control characters or null bytes, bounded length, then NFC-normalised and trimmed. */
export const text = (max: number, min = 1) =>
  z
    .string()
    .min(min)
    .max(max)
    .refine((s) => !hasControlChars(s), { message: 'control characters are not allowed' })
    .transform((s) => s.normalize('NFC').trim())
    .refine((s) => s.length >= min, { message: 'must not be blank' });

export const idSchema = z.string().uuid();
export const isoDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD')
  .refine((s) => !Number.isNaN(Date.parse(`${s}T00:00:00Z`)) && new Date(`${s}T00:00:00Z`).toISOString().startsWith(s), {
    message: 'invalid date',
  });
export const isoDateTimeSchema = z.string().datetime({ offset: true });

export const MAX_QTY = 100_000;
export const qtySchema = z.number().int().min(1).max(MAX_QTY);
export const nonNegativeQtySchema = z.number().int().min(0).max(1_000_000);

export const barcodeSchema = z.string().regex(/^[A-Za-z0-9._-]{1,64}$/, 'barcode: 1-64 of A-Z a-z 0-9 . _ -');
export const codeSchema = z.string().regex(/^[A-Z0-9][A-Z0-9_-]{0,31}$/, 'code: 1-32 of A-Z 0-9 _ - (upper case)');
export const batchCodeSchema = z.string().regex(/^[A-Za-z0-9._/-]{1,64}$/, 'batch: 1-64 of A-Z a-z 0-9 . _ / -');
export const countrySchema = z.string().regex(/^[A-Za-z]{2}$/, 'ISO 3166-1 alpha-2').transform((s) => s.toUpperCase());
export const emailSchema = z
  .string()
  .max(254)
  .email()
  .transform((s) => s.toLowerCase());
/** Client-generated idempotency key for floor actions (scans, receipts, adjustments). */
export const idempotencyKeySchema = z.string().regex(/^[A-Za-z0-9_-]{8,80}$/, 'idempotency key: 8-80 of A-Z a-z 0-9 _ -');

export const timeZoneSchema = z.string().max(64).refine(isValidTimeZone, { message: 'unknown IANA time zone' });
export const cutoffSchema = z.string().refine(isValidCutoff, { message: 'expected HH:MM (00:00-23:59)' });

export const latSchema = z.number().min(-90).max(90);
export const lonSchema = z.number().min(-180).max(180);

/** Query-string integers arrive as strings. */
export const queryInt = (min: number, max: number, dflt: number) =>
  z.coerce.number().int().min(min).max(max).default(dflt);

export const paginationSchema = z
  .object({
    limit: queryInt(1, 200, 50),
    cursor: z.string().max(200).optional(),
  })
  .strict();

export const uniqueBy = <T>(items: readonly T[], key: (t: T) => string): boolean =>
  new Set(items.map(key)).size === items.length;
