import { Inject, Injectable } from '@nestjs/common';
import { hashPassword } from '@ff/db/password';
import { type Db } from '@ff/db/client';
import { pgCode, SQLSTATE } from '@ff/db/pg-errors';
import { type StaffRole } from '@ff/shared/domain';
import { fail, ok, type Result } from '@ff/shared/result';
import { DB } from '../../infra/tokens';
import { toStaff } from './domain/mappers';

type Roles = readonly { role: StaffRole; warehouseId: string | null }[];

@Injectable()
export class AdminStaffService {
  constructor(@Inject(DB) private readonly db: Db) {}

  private async warehousesExist(roles: Roles): Promise<boolean> {
    const ids = [...new Set(roles.flatMap((r) => (r.warehouseId === null ? [] : [r.warehouseId])))];
    return (await this.db.warehouse.count({ where: { id: { in: ids } } })) === ids.length;
  }

  private dedupe = (roles: Roles): Roles => [
    ...new Map(roles.map((r) => [`${r.role}/${r.warehouseId ?? '-'}`, r])).values(),
  ];

  async create(input: {
    email: string;
    name: string;
    password: string;
    roles: Roles;
  }): Promise<Result<ReturnType<typeof toStaff>>> {
    if (!(await this.warehousesExist(input.roles)))
      return fail('VALIDATION_FAILED', 'unknown warehouse in roles');
    try {
      const s = await this.db.staff.create({
        data: {
          email: input.email,
          name: input.name,
          passwordHash: await hashPassword(input.password),
          roles: {
            create: this.dedupe(input.roles).map((r) => ({ role: r.role, warehouseId: r.warehouseId })),
          },
        },
        include: { roles: true },
      });
      return ok(toStaff(s));
    } catch (e) {
      if (pgCode(e) === SQLSTATE.uniqueViolation) return fail('DUPLICATE_EMAIL', 'email already in use');
      throw e;
    }
  }

  async list() {
    return {
      items: (await this.db.staff.findMany({ include: { roles: true }, orderBy: { email: 'asc' } })).map(
        toStaff,
      ),
    };
  }

  async update(
    id: string,
    patch: { name?: string; active?: boolean; roles?: Roles },
  ): Promise<Result<ReturnType<typeof toStaff>>> {
    if (patch.roles !== undefined && !(await this.warehousesExist(patch.roles))) {
      return fail('VALIDATION_FAILED', 'unknown warehouse in roles');
    }
    const found = await this.db.$transaction(async (tx) => {
      // updateMany with empty data reports 0 rows, so existence is checked explicitly.
      if ((await tx.staff.count({ where: { id } })) === 0) return false;
      await tx.staff.updateMany({
        where: { id },
        data: {
          ...(patch.name === undefined ? {} : { name: patch.name }),
          ...(patch.active === undefined ? {} : { active: patch.active }),
        },
      });
      if (patch.roles !== undefined) {
        await tx.staffRoleAssignment.deleteMany({ where: { staffId: id } });
        await tx.staffRoleAssignment.createMany({
          data: this.dedupe(patch.roles).map((r) => ({ staffId: id, ...r })),
        });
      }
      return true;
    });
    if (!found) return fail('NOT_FOUND', 'staff member not found');
    return ok(toStaff(await this.db.staff.findUniqueOrThrow({ where: { id }, include: { roles: true } })));
  }
}
