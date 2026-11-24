// Shop-facing inputs: orders, batch import, inbound requests (ASN), search.
import { z } from 'zod';
import { DELIVERY_METHODS, ORDER_STATUSES } from '../domain';
import {
  barcodeSchema,
  countrySchema,
  idSchema,
  latSchema,
  lonSchema,
  qtySchema,
  queryInt,
  text,
  uniqueBy,
} from './common';

export const MAX_ORDER_LINES = 500;
export const MAX_BATCH_ORDERS = 500;

export const externalNumberSchema = z.string().regex(/^[A-Za-z0-9._#/-]{1,64}$/, 'order number: 1-64 of A-Z a-z 0-9 . _ # / -');

export const addressSchema = z
  .object({
    name: text(200),
    line1: text(300),
    line2: text(300).optional(),
    city: text(120),
    postalCode: z.string().regex(/^[A-Za-z0-9 -]{2,16}$/, 'postal code'),
    country: countrySchema,
    phone: z.string().regex(/^\+?[0-9 ()-]{5,32}$/, 'phone').optional(),
    lat: latSchema.optional(),
    lon: lonSchema.optional(),
  })
  .strict()
  .refine((a) => (a.lat === undefined) === (a.lon === undefined), { message: 'lat and lon go together' });

export const orderLineInputSchema = z.object({ sku: barcodeSchema, qty: qtySchema }).strict();

export const createOrderSchema = z
  .object({
    externalNumber: externalNumberSchema,
    deliveryMethod: z.enum(DELIVERY_METHODS),
    address: addressSchema,
    lines: z
      .array(orderLineInputSchema)
      .min(1)
      .max(MAX_ORDER_LINES)
      .refine((l) => uniqueBy(l, (x) => x.sku), { message: 'DUPLICATE_LINE: each SKU may appear once' }),
  })
  .strict();

export const batchImportSchema = z
  .object({
    orders: z
      .array(createOrderSchema)
      .min(1)
      .max(MAX_BATCH_ORDERS)
      .refine((o) => uniqueBy(o, (x) => x.externalNumber), { message: 'order numbers must be unique in a batch' }),
  })
  .strict();

export const createInboundSchema = z
  .object({
    warehouseId: idSchema,
    reference: externalNumberSchema,
    lines: z
      .array(orderLineInputSchema)
      .min(1)
      .max(MAX_ORDER_LINES)
      .refine((l) => uniqueBy(l, (x) => x.sku), { message: 'each SKU may appear once' }),
  })
  .strict();

export const orderSearchSchema = z
  .object({
    q: z.string().max(100).optional(),
    status: z.enum(ORDER_STATUSES).optional(),
    warehouseId: idSchema.optional(),
    shopId: idSchema.optional(),
    limit: queryInt(1, 200, 50),
    cursor: z.string().max(200).optional(),
  })
  .strict();

export const stockQuerySchema = z
  .object({
    skuId: idSchema.optional(),
    sku: barcodeSchema.optional(),
    warehouseId: idSchema.optional(),
    shopId: idSchema.optional(),
    limit: queryInt(1, 200, 50),
    cursor: z.string().max(200).optional(),
  })
  .strict();

export type CreateOrderInput = z.infer<typeof createOrderSchema>;
export type AddressInput = z.infer<typeof addressSchema>;
export type BatchImportInput = z.infer<typeof batchImportSchema>;
