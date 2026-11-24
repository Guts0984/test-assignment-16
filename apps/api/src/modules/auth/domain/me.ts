import { type Principal } from '../../../common/auth/principal';
import { type MeDto } from '../dto/auth.dto';

export const toMe = (p: Principal): MeDto => ({
  kind: p.kind,
  id: p.id,
  name: p.kind === 'staff' ? p.name : null,
  email: p.kind === 'staff' ? p.email : null,
  shopId: p.kind === 'staff' ? null : p.shopId,
  roles: p.kind === 'staff' ? p.roles.map((r) => ({ role: r.role, warehouseId: r.warehouseId })) : [],
});
