// One error format for every endpoint (assignment invariant 12, plan.md A-41).
import { z } from 'zod';

export const ERROR_CODES = [
  // transport and validation
  'VALIDATION_FAILED',
  'MALFORMED_JSON',
  'UNSUPPORTED_MEDIA_TYPE',
  'PAYLOAD_TOO_LARGE',
  'NOT_FOUND',
  'METHOD_NOT_ALLOWED',
  'RATE_LIMITED',
  'CONFLICT',
  'UNEXPECTED',
  'UNAVAILABLE',
  // auth
  'UNAUTHENTICATED',
  'INVALID_CREDENTIALS',
  'TOKEN_INVALID',
  'TOKEN_REUSED',
  'FORBIDDEN',
  // catalog and setup
  'DUPLICATE_BARCODE',
  'DUPLICATE_CODE',
  'DUPLICATE_EMAIL',
  'UNKNOWN_SKU',
  'INVALID_TIMEZONE',
  // orders
  'ORDER_CONFLICT',
  'DUPLICATE_LINE',
  'INVALID_TRANSITION',
  'ORDER_CANCELLED',
  'ORDER_NOT_CANCELLABLE',
  // stock and floor
  'INSUFFICIENT_STOCK',
  'CAPACITY_EXCEEDED',
  'CELL_BLOCKED',
  'WRONG_CELL',
  'WRONG_SKU',
  'WRONG_BATCH',
  'ALREADY_SCANNED',
  'LINE_COMPLETE',
  'TASK_NOT_ASSIGNED',
  'NO_TASK_AVAILABLE',
  'BATCH_REQUIRED',
  'EXPIRY_IN_PAST',
  'COUNT_ALREADY_OPEN',
  'COUNT_NOT_OPEN',
  'APPROVAL_REQUIRED',
  'IDEMPOTENCY_MISMATCH',
  'TRANSFER_STATE',
  'RECEIPT_STATE',
  'JOB_NOT_RERUNNABLE',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export const errorCodeSchema = z.enum(ERROR_CODES);

export const fieldErrorSchema = z.object({
  path: z.string(),
  code: z.string(),
  message: z.string(),
});

export const errorBodySchema = z.object({
  error: z.object({
    code: errorCodeSchema,
    message: z.string(),
    fields: z.array(fieldErrorSchema).optional(),
    details: z.record(z.unknown()).optional(),
    requestId: z.string(),
  }),
});

export type FieldError = z.infer<typeof fieldErrorSchema>;
export type ErrorBody = z.infer<typeof errorBodySchema>;

/** HTTP status for each domain code. Unlisted codes map to 422 (a well-formed but unacceptable request). */
const STATUS: Partial<Record<ErrorCode, number>> = {
  VALIDATION_FAILED: 400,
  MALFORMED_JSON: 400,
  UNSUPPORTED_MEDIA_TYPE: 415,
  PAYLOAD_TOO_LARGE: 413,
  NOT_FOUND: 404,
  METHOD_NOT_ALLOWED: 405,
  RATE_LIMITED: 429,
  CONFLICT: 409,
  UNEXPECTED: 500,
  UNAVAILABLE: 503,
  UNAUTHENTICATED: 401,
  INVALID_CREDENTIALS: 401,
  TOKEN_INVALID: 401,
  TOKEN_REUSED: 401,
  FORBIDDEN: 403,
  DUPLICATE_BARCODE: 409,
  DUPLICATE_CODE: 409,
  DUPLICATE_EMAIL: 409,
  ORDER_CONFLICT: 409,
  ALREADY_SCANNED: 409,
  COUNT_ALREADY_OPEN: 409,
  IDEMPOTENCY_MISMATCH: 409,
};

export const httpStatusFor = (code: ErrorCode): number => STATUS[code] ?? 422;
