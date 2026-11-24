import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { barcodeSchema, idSchema } from '@ff/shared/schemas/common';

export const stockQuerySchema = z
  .object({
    q: z.string().max(64).optional(),
    warehouseId: idSchema.optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
    cursor: z.string().max(200).optional(),
  })
  .strict();
export class StockQueryDto extends createZodDto(stockQuerySchema) {}

export const staffStockQuerySchema = z.object({ sku: barcodeSchema }).strict();
export class StaffStockQueryDto extends createZodDto(staffStockQuerySchema) {}

export const warehouseStockSchema = z.object({
  warehouseId: z.string().uuid(),
  warehouseCode: z.string(),
  onShelf: z.number().int(),
  reserved: z.number().int(),
  available: z.number().int(),
  inTransit: z.number().int(),
  receiving: z.number().int(),
});
export const skuStockSchema = z.object({
  skuId: z.string().uuid(),
  skuCode: z.string(),
  skuName: z.string(),
  warehouses: z.array(warehouseStockSchema),
});
export class StockPageDto extends createZodDto(z.object({ items: z.array(skuStockSchema), nextCursor: z.string().nullable(), asOf: z.string() })) {}
