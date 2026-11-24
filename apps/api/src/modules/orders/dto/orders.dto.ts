import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { DELIVERY_METHODS, ORDER_STATUSES } from '@ff/shared/domain';
import { batchImportSchema, createOrderSchema, orderSearchSchema } from '@ff/shared/schemas/orders';

export class CreateOrderDto extends createZodDto(createOrderSchema) {}
export class BatchImportDto extends createZodDto(batchImportSchema) {}
export class OrderSearchDto extends createZodDto(orderSearchSchema) {}

export const importResultSchema = z.object({
  orderId: z.string().uuid(),
  created: z.boolean(),
  status: z.enum(ORDER_STATUSES),
});
export class ImportResultDto extends createZodDto(importResultSchema) {}
export class BatchAcceptedDto extends createZodDto(z.object({ batchId: z.string().uuid() })) {}
export class ImportBatchDto extends createZodDto(
  z.object({
    id: z.string().uuid(),
    status: z.enum(['pending', 'done', 'failed']),
    results: z
      .array(
        z.object({
          externalNumber: z.string(),
          ok: z.boolean(),
          orderId: z.string().uuid().optional(),
          created: z.boolean().optional(),
          code: z.string().optional(),
          message: z.string().optional(),
        }),
      )
      .nullable(),
  }),
) {}

export const orderListItemSchema = z.object({
  id: z.string().uuid(),
  shopId: z.string().uuid(),
  externalNumber: z.string(),
  status: z.enum(ORDER_STATUSES),
  deliveryMethod: z.enum(DELIVERY_METHODS),
  customerName: z.string(),
  warehouseId: z.string().uuid().nullable(),
  receivedAt: z.string(),
  targetCutoffAt: z.string().nullable(),
  shipDay: z.string().nullable(),
});
export class OrderPageDto extends createZodDto(
  z.object({ items: z.array(orderListItemSchema), nextCursor: z.string().nullable() }),
) {}

export const orderDetailSchema = orderListItemSchema.extend({
  statusVersion: z.number().int(),
  address: z.record(z.unknown()),
  warehouseCode: z.string().nullable(),
  packedAt: z.string().nullable(),
  shippedAt: z.string().nullable(),
  cancelledAt: z.string().nullable(),
  lines: z.array(
    z.object({
      id: z.string().uuid(),
      skuId: z.string().uuid(),
      skuCode: z.string(),
      skuName: z.string(),
      qty: z.number().int(),
      reservedQty: z.number().int(),
      pickedQty: z.number().int(),
    }),
  ),
  history: z.array(
    z.object({
      version: z.number().int(),
      from: z.enum(ORDER_STATUSES).nullable(),
      to: z.enum(ORDER_STATUSES),
      actorType: z.string(),
      reason: z.string().nullable(),
      at: z.string(),
    }),
  ),
});
export class OrderDetailDto extends createZodDto(orderDetailSchema) {}
