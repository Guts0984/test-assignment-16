import { describe, expect, it } from 'vitest';
import { hasRole, homeFor, isAdmin, warehousesWith } from './roles';
import type { Me } from './session';

const w1 = '00000000-0000-4000-8000-000000000001';
const w2 = '00000000-0000-4000-8000-000000000002';
const me = (kind: Me['kind'], roles: Me['roles']): Me => ({
  kind,
  id: 'x',
  name: null,
  email: null,
  shopId: kind === 'staff' ? null : 's',
  roles,
});

describe('roles', () => {
  it('routes each kind of user to its home screen', () => {
    expect(homeFor(me('api_key', []), null)).toBe('/shop/stock');
    expect(homeFor(me('staff', [{ role: 'admin', warehouseId: null }]), null)).toBe('/admin/warehouses');
    expect(homeFor(me('staff', [{ role: 'picker', warehouseId: w1 }]), null)).toBe(`/w/${w1}/picker`);
    expect(homeFor(me('staff', [{ role: 'shift_lead', warehouseId: w2 }]), null)).toBe(`/w/${w2}/dashboard`);
    expect(homeFor(me('staff', [{ role: 'storekeeper', warehouseId: w1 }]), null)).toBe(`/w/${w1}/receiving`);
  });
  it('lists warehouses per role and treats admin as global', () => {
    const m = me('staff', [
      { role: 'picker', warehouseId: w1 },
      { role: 'shift_lead', warehouseId: w2 },
    ]);
    expect(warehousesWith(m, ['shift_lead'])).toEqual([w2]);
    expect(warehousesWith(m, ['picker', 'shift_lead'])).toEqual([w1, w2]);
    expect(hasRole(m, ['storekeeper'])).toBe(false);
    expect(isAdmin(me('staff', [{ role: 'admin', warehouseId: null }]))).toBe(true);
  });
});
