import { ParseUUIDPipe } from '@nestjs/common';
import { httpError } from './errors';

/** Path ids must be UUIDs; anything else is a clean 400 (never a database error). */
export const UUID = new ParseUUIDPipe({
  version: undefined,
  exceptionFactory: () => httpError('VALIDATION_FAILED', 'id must be a UUID'),
});
