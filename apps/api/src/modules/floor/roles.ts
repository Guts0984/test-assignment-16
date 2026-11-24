import { type StaffRole } from '@ff/shared/domain';
import { hasRoleAt, type Principal } from '../../common/auth/principal';

export const STORE: readonly StaffRole[] = ['storekeeper', 'shift_lead'];
export const PICK: readonly StaffRole[] = ['picker'];
export const PICK_VIEW: readonly StaffRole[] = ['picker', 'shift_lead'];
export const PACK: readonly StaffRole[] = ['packer', 'shift_lead'];
export const LEAD: readonly StaffRole[] = ['shift_lead'];
export const ANY_FLOOR: readonly StaffRole[] = ['shift_lead', 'storekeeper', 'picker', 'packer'];

/** The role a staff member acts in at a warehouse, for the status transition table. */
export const actingAs = <R extends StaffRole>(
  p: Principal,
  warehouseId: string,
  preferred: R,
  fallback: 'shift_lead',
): R | 'shift_lead' =>
  hasRoleAt(p, warehouseId, [preferred]) && !(p.kind === 'staff' && p.roles.some((r) => r.role === 'admin'))
    ? preferred
    : fallback;

export const isLeadAt = (p: Principal, warehouseId: string): boolean => hasRoleAt(p, warehouseId, LEAD);
