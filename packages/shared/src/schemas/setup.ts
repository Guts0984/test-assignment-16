// Admin setup inputs: auth, warehouses, zones, cells, shops, staff, SKUs.
import { z } from 'zod';
import { STAFF_ROLES } from '../domain';
import {
  barcodeSchema,
  codeSchema,
  countrySchema,
  cutoffSchema,
  emailSchema,
  idSchema,
  isoDateSchema,
  latSchema,
  lonSchema,
  text,
  timeZoneSchema,
  uniqueBy,
} from './common';

export const loginSchema = z.object({ email: emailSchema, password: z.string().min(1).max(200) }).strict();

export const createWarehouseSchema = z
  .object({
    code: codeSchema,
    name: text(120),
    country: countrySchema,
    timeZone: timeZoneSchema,
    cutoffLocal: cutoffSchema,
    workingDays: z
      .array(z.number().int().min(1).max(7))
      .min(1)
      .max(7)
      .refine((d) => new Set(d).size === d.length, { message: 'working days must be unique' }),
    holidays: z.array(isoDateSchema).max(366).default([]),
    lat: latSchema.optional(),
    lon: lonSchema.optional(),
  })
  .strict();

export const updateWarehouseSchema = createWarehouseSchema.omit({ code: true }).partial().strict();

export const createZoneSchema = z.object({ code: codeSchema, name: text(120) }).strict();

export const cellInputSchema = z
  .object({
    code: codeSchema,
    walkOrder: z.number().int().min(0).max(1_000_000),
    capacityVolumeCm3: z.number().int().min(1).max(100_000_000),
    capacityWeightG: z.number().int().min(1).max(100_000_000),
  })
  .strict();

export const createCellsSchema = z
  .object({
    cells: z
      .array(cellInputSchema)
      .min(1)
      .max(5000)
      .refine((c) => uniqueBy(c, (x) => x.code), { message: 'cell codes must be unique' }),
  })
  .strict();

export const createShopSchema = z
  .object({
    code: codeSchema,
    name: text(120),
    webhookUrl: z
      .string()
      .max(500)
      .url()
      .refine((u) => /^https?:\/\//i.test(u), { message: 'http or https only' }),
    minShelfLifeDays: z.number().int().min(0).max(3650),
  })
  .strict();

export const updateShopSchema = createShopSchema.omit({ code: true }).partial().strict();

export const roleAssignmentSchema = z
  .object({ role: z.enum(STAFF_ROLES), warehouseId: idSchema.nullable() })
  .strict()
  .refine((r) => (r.role === 'admin') === (r.warehouseId === null), {
    message: 'admin is global (warehouseId null); other roles need a warehouse',
  });

export const createStaffSchema = z
  .object({
    email: emailSchema,
    name: text(120),
    password: z.string().min(8).max(200),
    roles: z.array(roleAssignmentSchema).max(50).default([]),
  })
  .strict();

export const updateStaffSchema = z
  .object({ name: text(120).optional(), active: z.boolean().optional(), roles: z.array(roleAssignmentSchema).max(50).optional() })
  .strict();

export const createShopUserSchema = z
  .object({ email: emailSchema, name: text(120), password: z.string().min(8).max(200) })
  .strict();

export const createSkuSchema = z
  .object({
    code: barcodeSchema,
    name: text(200),
    barcode: barcodeSchema,
    weightG: z.number().int().min(1).max(1_000_000),
    lengthMm: z.number().int().min(1).max(10_000),
    widthMm: z.number().int().min(1).max(10_000),
    heightMm: z.number().int().min(1).max(10_000),
    tracksExpiry: z.boolean(),
  })
  .strict();

export const updateSkuSchema = createSkuSchema.pick({ name: true, weightG: true, lengthMm: true, widthMm: true, heightMm: true }).partial().strict();

export type CreateWarehouseInput = z.infer<typeof createWarehouseSchema>;
export type CreateCellsInput = z.infer<typeof createCellsSchema>;
export type CreateShopInput = z.infer<typeof createShopSchema>;
export type CreateStaffInput = z.infer<typeof createStaffSchema>;
export type CreateSkuInput = z.infer<typeof createSkuSchema>;
