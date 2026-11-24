// Data access for authentication (staff, shop users, API keys, refresh token families).
import { type Db } from '@ff/db/client';
import { type StaffRole } from '@ff/shared/domain';

export const findStaffByEmail = (db: Db, email: string) =>
  db.staff.findUnique({ where: { email }, include: { roles: true } });

export const findStaffById = (db: Db, id: string) => db.staff.findUnique({ where: { id }, include: { roles: true } });

export const findShopUserByEmail = (db: Db, email: string) => db.shopUser.findUnique({ where: { email } });
export const findShopUserById = (db: Db, id: string) => db.shopUser.findUnique({ where: { id } });

export const findApiKeyByPrefix = (db: Db, prefix: string) => db.shopApiKey.findUnique({ where: { prefix } });

export const insertRefreshToken = (
  db: Db,
  t: { familyId: string; subjectType: 'staff' | 'shop_user'; subjectId: string; tokenHash: string; expiresAt: Date; now: Date },
) =>
  db.refreshToken.create({
    data: {
      familyId: t.familyId,
      subjectType: t.subjectType,
      subjectId: t.subjectId,
      tokenHash: t.tokenHash,
      expiresAt: t.expiresAt,
      createdAt: t.now,
    },
  });

export const findRefreshToken = (db: Db, tokenHash: string) => db.refreshToken.findUnique({ where: { tokenHash } });

/** Marks a refresh token used exactly once; a second caller gets false (reuse). */
export const consumeRefreshToken = async (db: Db, id: string, now: Date): Promise<boolean> =>
  (await db.refreshToken.updateMany({ where: { id, usedAt: null, revokedAt: null }, data: { usedAt: now } })).count === 1;

export const revokeFamily = (db: Db, familyId: string, now: Date) =>
  db.refreshToken.updateMany({ where: { familyId, revokedAt: null }, data: { revokedAt: now } });

export const isFamilyRevoked = async (db: Db, familyId: string): Promise<boolean> =>
  (await db.refreshToken.count({ where: { familyId, revokedAt: { not: null } } })) > 0;

export type StaffRoleRow = { role: StaffRole; warehouseId: string | null };
