import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { createSkuSchema, updateSkuSchema } from '@ff/shared/schemas/setup';

export class CreateSkuDto extends createZodDto(createSkuSchema) {}
export class UpdateSkuDto extends createZodDto(updateSkuSchema) {}

export const skuSchema = z.object({
  id: z.string().uuid(),
  code: z.string(),
  name: z.string(),
  barcode: z.string(),
  weightG: z.number().int(),
  lengthMm: z.number().int(),
  widthMm: z.number().int(),
  heightMm: z.number().int(),
  tracksExpiry: z.boolean(),
});
export class SkuDto extends createZodDto(skuSchema) {}
export class SkuPageDto extends createZodDto(z.object({ items: z.array(skuSchema), nextCursor: z.string().nullable() })) {}

export const skuQuerySchema = z
  .object({
    q: z.string().max(64).optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
    cursor: z.string().max(200).optional(),
  })
  .strict();
export class SkuQueryDto extends createZodDto(skuQuerySchema) {}
