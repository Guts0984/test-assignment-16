// Who is calling. Resolved on the server for every request and socket (invariant 12).
import { type StaffRole } from '@ff/shared/domain';

export type RoleAt = { readonly role: StaffRole; readonly warehouseId: string | null };

export type StaffPrincipal = {
  readonly kind: 'staff';
  readonly id: string;
  readonly email: string;
  readonly name: string;
  readonly roles: readonly RoleAt[];
  readonly familyId: string;
};
export type ShopUserPrincipal = {
  readonly kind: 'shop_user';
  readonly id: string;
  readonly shopId: string;
  readonly familyId: string;
};
export type ApiKeyPrincipal = {
  readonly kind: 'api_key';
  readonly id: string;
  readonly shopId: string;
  readonly prefix: string;
};
export type Principal = StaffPrincipal | ShopUserPrincipal | ApiKeyPrincipal;
export type PrincipalKind = Principal['kind'];

export const isAdmin = (p: Principal): boolean =>
  p.kind === 'staff' && p.roles.some((r) => r.role === 'admin');

export const shopIdOf = (p: Principal): string | null => (p.kind === 'staff' ? null : p.shopId);

/** Warehouses where the staff member holds any of `roles` (any role when empty). Admin: all. */
export const warehousesOf = (p: Principal, roles: readonly StaffRole[] = []): readonly string[] | 'all' => {
  if (p.kind !== 'staff') return [];
  if (isAdmin(p)) return 'all';
  return [
    ...new Set(
      p.roles
        .filter((r) => r.warehouseId !== null && (roles.length === 0 || roles.includes(r.role)))
        .map((r) => r.warehouseId as string),
    ),
  ];
};

export const hasRoleAt = (p: Principal, warehouseId: string, roles: readonly StaffRole[]): boolean => {
  const w = warehousesOf(p, roles);
  return w === 'all' || w.includes(warehouseId);
};

export const hasAnyRole = (p: Principal, roles: readonly StaffRole[]): boolean =>
  p.kind === 'staff' && (isAdmin(p) || p.roles.some((r) => roles.includes(r.role)));
