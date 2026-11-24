import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { createInboundSchema } from '@ff/shared/schemas/orders';

export class CreateInboundDto extends createZodDto(createInboundSchema) {}

export const inboundSchema = z.object({
  id: z.string().uuid(),
  warehouseId: z.string().uuid(),
  reference: z.string(),
  status: z.string(),
  createdAt: z.string(),
  lines: z.array(z.object({ skuId: z.string().uuid(), skuCode: z.string(), expectedQty: z.number().int() })),
  discrepancies: z.array(
    z.object({ skuId: z.string().uuid(), skuCode: z.string(), expectedQty: z.number().int(), receivedQty: z.number().int() }),
  ),
});
export class InboundDto extends createZodDto(inboundSchema) {}
export class InboundListDto extends createZodDto(z.object({ items: z.array(inboundSchema) })) {}
