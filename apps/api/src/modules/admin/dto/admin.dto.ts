import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { STAFF_ROLES } from '@ff/shared/domain';
import {
  createCellsSchema,
  createShopSchema,
  createShopUserSchema,
  createStaffSchema,
  createWarehouseSchema,
  createZoneSchema,
  updateShopSchema,
  updateStaffSchema,
  updateWarehouseSchema,
} from '@ff/shared/schemas/setup';

export class CreateWarehouseDto extends createZodDto(createWarehouseSchema) {}
export class UpdateWarehouseDto extends createZodDto(updateWarehouseSchema) {}
export class CreateZoneDto extends createZodDto(createZoneSchema) {}
export class CreateCellsDto extends createZodDto(createCellsSchema) {}
export class CreateShopDto extends createZodDto(createShopSchema) {}
export class UpdateShopDto extends createZodDto(updateShopSchema) {}
export class CreateStaffDto extends createZodDto(createStaffSchema) {}
export class UpdateStaffDto extends createZodDto(updateStaffSchema) {}
export class CreateShopUserDto extends createZodDto(createShopUserSchema) {}

export const warehouseSchema = z.object({
  id: z.string().uuid(),
  code: z.string(),
  name: z.string(),
  country: z.string(),
  timeZone: z.string(),
  cutoffLocal: z.string(),
  workingDays: z.array(z.number().int()),
  holidays: z.array(z.string()),
  lat: z.number().nullable(),
  lon: z.number().nullable(),
});
export class WarehouseDto extends createZodDto(warehouseSchema) {}
export class WarehouseListDto extends createZodDto(z.object({ items: z.array(warehouseSchema) })) {}

export const zoneSchema = z.object({ id: z.string().uuid(), warehouseId: z.string().uuid(), code: z.string(), name: z.string() });
export class ZoneDto extends createZodDto(zoneSchema) {}

export const cellSchema = z.object({
  id: z.string().uuid(),
  code: z.string(),
  kind: z.string(),
  zoneId: z.string().uuid().nullable(),
  walkOrder: z.number().int(),
  capacityVolumeCm3: z.number(),
  capacityWeightG: z.number(),
  blockedReason: z.string().nullable(),
});
export class CellListDto extends createZodDto(z.object({ items: z.array(cellSchema), nextCursor: z.string().nullable() })) {}
export class CreatedCellsDto extends createZodDto(z.object({ created: z.number().int() })) {}

export const shopSchema = z.object({
  id: z.string().uuid(),
  code: z.string(),
  name: z.string(),
  webhookUrl: z.string(),
  minShelfLifeDays: z.number().int(),
});
export class ShopDto extends createZodDto(shopSchema) {}
export class ShopListDto extends createZodDto(z.object({ items: z.array(shopSchema) })) {}
export class CreatedShopDto extends createZodDto(
  z.object({ shop: shopSchema, apiKey: z.string().describe('shown once'), webhookSecret: z.string().describe('shown once') }),
) {}

export const apiKeySchema = z.object({
  id: z.string().uuid(),
  prefix: z.string(),
  label: z.string(),
  createdAt: z.string(),
  revokedAt: z.string().nullable(),
});
export class ApiKeyListDto extends createZodDto(z.object({ items: z.array(apiKeySchema) })) {}
export class CreatedApiKeyDto extends createZodDto(z.object({ key: apiKeySchema, apiKey: z.string().describe('shown once') })) {}
export class ShopUserDto extends createZodDto(
  z.object({ id: z.string().uuid(), shopId: z.string().uuid(), email: z.string(), name: z.string() }),
) {}

export const staffSchema = z.object({
  id: z.string().uuid(),
  email: z.string(),
  name: z.string(),
  active: z.boolean(),
  roles: z.array(z.object({ role: z.enum(STAFF_ROLES), warehouseId: z.string().uuid().nullable() })),
});
export class StaffDto extends createZodDto(staffSchema) {}
export class StaffListDto extends createZodDto(z.object({ items: z.array(staffSchema) })) {}

export const cellQuerySchema = z
  .object({
    code: z.string().max(32).optional(),
    limit: z.coerce.number().int().min(1).max(500).default(100),
    cursor: z.string().max(200).optional(),
  })
  .strict();
export class CellQueryDto extends createZodDto(cellQuerySchema) {}
