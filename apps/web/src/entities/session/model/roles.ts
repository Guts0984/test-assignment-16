// Pure role helpers for navigation and guarding screens. The server enforces every right; this only
// decides what to show.
import type { Me } from './session';

export type RoleName = 'admin' | 'shift_lead' | 'storekeeper' | 'picker' | 'packer';

export const isShop = (me: Me): boolean => me.kind !== 'staff';
export const isAdmin = (me: Me): boolean => me.roles.some((r) => r.role === 'admin');

export const warehousesWith = (me: Me, roles: readonly RoleName[]): readonly string[] => [
  ...new Set(
    me.roles
      .filter((r) => r.warehouseId !== null && roles.includes(r.role))
      .map((r) => r.warehouseId as string),
  ),
];

export const hasRole = (me: Me, roles: readonly RoleName[]): boolean =>
  isAdmin(me) || me.roles.some((r) => roles.includes(r.role));

/** Where a user lands after signing in. */
export const homeFor = (me: Me, warehouseId: string | null): string => {
  if (isShop(me)) return '/shop/stock';
  if (isAdmin(me)) return '/admin/warehouses';
  const w = warehouseId ?? me.roles.find((r) => r.warehouseId !== null)?.warehouseId ?? null;
  if (w === null) return '/login';
  const first = me.roles.find((r) => r.warehouseId === w)?.role;
  return first === 'picker'
    ? `/w/${w}/picker`
    : first === 'packer'
      ? `/w/${w}/packer`
      : first === 'storekeeper'
        ? `/w/${w}/receiving`
        : `/w/${w}/dashboard`;
};
