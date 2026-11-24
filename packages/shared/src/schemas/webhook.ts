import { z } from 'zod';

export const webhookEnvelopeSchema = z
  .object({
    eventId: z.string().uuid(),
    type: z.enum(['order.status_changed', 'stock.available_changed']),
    stream: z.string().regex(/^(order|stock):[0-9a-f-]{36}$/),
    version: z.number().int().positive(),
    occurredAt: z.string().datetime({ offset: true }),
    data: z.record(z.unknown()),
  })
  .strict();
