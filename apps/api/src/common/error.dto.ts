import { createZodDto } from 'nestjs-zod';
import { errorBodySchema } from '@ff/shared/errors';

/** The shared error body, declared on every operation in OpenAPI. */
export class ErrorBodyDto extends createZodDto(errorBodySchema) {}
