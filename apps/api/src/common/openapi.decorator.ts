// Declares the shared error body for the statuses an operation can return.
import { applyDecorators, type Type } from '@nestjs/common';
import { ApiExtraModels, ApiOkResponse, ApiCreatedResponse, ApiResponse } from '@nestjs/swagger';
import { ErrorBodyDto } from './error.dto';

const DESCRIPTIONS: Readonly<Record<number, string>> = {
  400: 'Validation failed or malformed JSON',
  401: 'Missing or invalid credentials',
  403: 'Authenticated but not allowed',
  404: 'Not found',
  409: 'Conflict (duplicate, concurrent change)',
  413: 'Body too large',
  415: 'Body is not JSON',
  422: 'Business rule refused the request',
  429: 'Rate limited (see Retry-After)',
  500: 'Unexpected error (shared format, no internals)',
};

/** Every operation documents the shared error body; protected ones also 401/403. */
export const ApiErrors = (...extra: number[]) =>
  applyDecorators(
    ApiExtraModels(ErrorBodyDto),
    ...[...new Set([400, 429, 500, ...extra])].map((status) =>
      ApiResponse({ status, description: DESCRIPTIONS[status] ?? 'Error', type: ErrorBodyDto }),
    ),
  );

export const ApiProtectedErrors = (...extra: number[]) => ApiErrors(401, 403, ...extra);

export const Ok = (type: Type<unknown>) => ApiOkResponse({ type });
export const Created = (type: Type<unknown>) => ApiCreatedResponse({ type });
