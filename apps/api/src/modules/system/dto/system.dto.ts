import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { testClockSchema } from '@ff/shared/schemas/floor';

export class TimeDto extends createZodDto(
  z.object({
    now: z.string().describe('server time (the shared test clock in tests)'),
    instance: z.string(),
  }),
) {}
export class HealthDto extends createZodDto(z.object({ ok: z.boolean(), instance: z.string() })) {}
export class TestClockDto extends createZodDto(testClockSchema) {}
export class TestClockResultDto extends createZodDto(z.object({ now: z.string(), offsetMs: z.number() })) {}
