// Warehouse floor inputs: receiving, putaway, moves, transfers, picking, packing, counts, reports.
import { z } from 'zod';
import {
  barcodeSchema,
  batchCodeSchema,
  codeSchema,
  idSchema,
  idempotencyKeySchema,
  isoDateSchema,
  isoDateTimeSchema,
  nonNegativeQtySchema,
  qtySchema,
  text,
  uniqueBy,
} from './common';

export const createReceiptSchema = z.object({ shopId: idSchema, inboundId: idSchema.optional() }).strict();

export const receiptLineSchema = z
  .object({
    barcode: barcodeSchema,
    qty: qtySchema,
    batchCode: batchCodeSchema.optional(),
    expiresOn: isoDateSchema.optional(),
    idempotencyKey: idempotencyKeySchema,
  })
  .strict()
  .refine((l) => (l.batchCode === undefined) === (l.expiresOn === undefined), {
    message: 'batchCode and expiresOn go together',
  });

export const putawaySuggestSchema = z
  .object({ sourceLocationId: idSchema, skuId: idSchema, batchId: idSchema, qty: qtySchema })
  .strict();

export const putawayConfirmSchema = z
  .object({
    sourceLocationId: idSchema,
    skuId: idSchema,
    batchId: idSchema,
    qty: qtySchema,
    cellCode: codeSchema,
    idempotencyKey: idempotencyKeySchema,
  })
  .strict();

export const moveSchema = z
  .object({
    fromCellCode: codeSchema,
    toCellCode: codeSchema,
    skuId: idSchema,
    batchId: idSchema,
    qty: qtySchema,
    idempotencyKey: idempotencyKeySchema,
  })
  .strict()
  .refine((m) => m.fromCellCode !== m.toCellCode, { message: 'source and target cell must differ' });

export const transferLineSchema = z.object({ cellId: idSchema, skuId: idSchema, batchId: idSchema, qty: qtySchema }).strict();

export const createTransferSchema = z
  .object({
    toWarehouseId: idSchema,
    lines: z
      .array(transferLineSchema)
      .min(1)
      .max(500)
      .refine((l) => uniqueBy(l, (x) => `${x.cellId}/${x.batchId}`), { message: 'duplicate transfer line' }),
    idempotencyKey: idempotencyKeySchema,
  })
  .strict();

export const receiveTransferSchema = z
  .object({
    lines: z
      .array(z.object({ skuId: idSchema, batchId: idSchema, qty: nonNegativeQtySchema }).strict())
      .min(1)
      .max(500),
    idempotencyKey: idempotencyKeySchema,
  })
  .strict();

export const scanCellSchema = z.object({ cellCode: codeSchema }).strict();

export const scanItemSchema = z
  .object({
    lineId: idSchema,
    cellCode: codeSchema,
    barcode: barcodeSchema,
    batchCode: batchCodeSchema.optional(),
    qty: qtySchema.default(1),
    idempotencyKey: idempotencyKeySchema,
  })
  .strict();

export const shortageSchema = z
  .object({ lineId: idSchema, foundQty: nonNegativeQtySchema, idempotencyKey: idempotencyKeySchema })
  .strict();

export const reassignSchema = z.object({ pickerId: idSchema }).strict();

export const packSchema = z
  .object({ orderRef: z.string().regex(/^[A-Za-z0-9._#/-]{1,64}$/, 'scanned order reference'), idempotencyKey: idempotencyKeySchema })
  .strict();

export const shipSchema = z
  .object({ orderIds: z.array(idSchema).min(1).max(1000).optional(), idempotencyKey: idempotencyKeySchema })
  .strict();

export const createCountSchema = z
  .object({ cellIds: z.array(idSchema).min(1).max(100), assigneeId: idSchema.optional() })
  .strict()
  .refine((c) => new Set(c.cellIds).size === c.cellIds.length, { message: 'cells must be unique' });

export const submitCountSchema = z
  .object({
    lines: z
      .array(
        z
          .object({ skuId: idSchema, batchId: idSchema, countedQty: nonNegativeQtySchema, reason: text(500).optional() })
          .strict(),
      )
      .max(1000)
      .refine((l) => uniqueBy(l, (x) => `${x.skuId}/${x.batchId}`), { message: 'duplicate count line' }),
    idempotencyKey: idempotencyKeySchema,
  })
  .strict();

export const approveCountSchema = z.object({ approve: z.boolean(), note: text(500).optional() }).strict();

export const MAX_REPORT_DAYS = 366;

export const reportQuerySchema = z
  .object({
    from: isoDateSchema,
    to: isoDateSchema,
    warehouseId: idSchema.optional(),
    staffId: idSchema.optional(),
  })
  .strict()
  .refine((q) => q.from <= q.to, { message: 'from must not be after to', path: ['from'] })
  .refine((q) => (Date.parse(q.to) - Date.parse(q.from)) / 86_400_000 < MAX_REPORT_DAYS, {
    message: `period is limited to ${MAX_REPORT_DAYS} days`,
    path: ['to'],
  });

export const testClockSchema = z
  .object({
    setTo: isoDateTimeSchema.optional(),
    advanceMs: z.number().int().min(0).max(400 * 86_400_000).optional(),
    reset: z.boolean().optional(),
  })
  .strict()
  .refine((c) => [c.setTo, c.advanceMs, c.reset].filter((x) => x !== undefined).length === 1, {
    message: 'exactly one of setTo, advanceMs, reset',
  });

export type ScanItemInput = z.infer<typeof scanItemSchema>;
export type SubmitCountInput = z.infer<typeof submitCountSchema>;
export type ReportQuery = z.infer<typeof reportQuerySchema>;
