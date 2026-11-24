// Row -> response mappers for admin resources (never leak hashes or encrypted secrets).
import {
  type Location,
  type Shop,
  type ShopApiKey,
  type Staff,
  type StaffRoleAssignment,
  type Warehouse,
} from '@ff/db/client';

export const toWarehouse = (w: Warehouse) => ({
  id: w.id,
  code: w.code,
  name: w.name,
  country: w.country,
  timeZone: w.timeZone,
  cutoffLocal: w.cutoffLocal,
  workingDays: w.workingDays,
  holidays: w.holidays,
  lat: w.lat,
  lon: w.lon,
});

export const toCell = (c: Location) => ({
  id: c.id,
  code: c.code,
  kind: c.kind,
  zoneId: c.zoneId,
  walkOrder: c.walkOrder,
  capacityVolumeCm3: Number(c.capacityVolumeCm3),
  capacityWeightG: Number(c.capacityWeightG),
  blockedReason: c.blockedReason,
});

export const toShop = (s: Shop) => ({
  id: s.id,
  code: s.code,
  name: s.name,
  webhookUrl: s.webhookUrl,
  minShelfLifeDays: s.minShelfLifeDays,
});

export const toApiKey = (k: ShopApiKey) => ({
  id: k.id,
  prefix: k.prefix,
  label: k.label,
  createdAt: k.createdAt.toISOString(),
  revokedAt: k.revokedAt?.toISOString() ?? null,
});

export const toStaff = (s: Staff & { roles: StaffRoleAssignment[] }) => ({
  id: s.id,
  email: s.email,
  name: s.name,
  active: s.active,
  roles: s.roles.map((r) => ({ role: r.role, warehouseId: r.warehouseId })),
});
