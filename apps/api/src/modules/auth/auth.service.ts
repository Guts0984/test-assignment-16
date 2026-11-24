// Authentication: login, refresh rotation with reuse detection, logout, bearer resolution.
import { randomUUID } from 'node:crypto';
import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import { hash as argonHash, argon2id, verify as argonVerify } from 'argon2';
import { type Db } from '@ff/db/client';
import { type Clock } from '@ff/core/clock';
import { apiKeyMatches, parseApiKey } from '@ff/shared/crypto/secrets';
import { fail, ok, type Result } from '@ff/shared/result';
import { type ApiEnv } from '../../config/env';
import { CLOCK, DB, ENV } from '../../infra/tokens';
import { type Principal } from '../../common/auth/principal';
import {
  hashToken,
  looksLikeJwt,
  newRefreshToken,
  signAccessToken,
  verifyAccessToken,
} from './domain/tokens';
import * as repo from './repo/auth.repo';

export type Session = {
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly expiresIn: number;
  readonly principal: Principal;
};

@Injectable()
export class AuthService implements OnModuleInit {
  private dummyHash = '';

  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(ENV) private readonly env: ApiEnv,
  ) {}

  async onModuleInit(): Promise<void> {
    this.dummyHash = await argonHash(randomUUID(), { type: argon2id });
  }

  async login(email: string, password: string): Promise<Result<Session>> {
    const staff = await repo.findStaffByEmail(this.db, email);
    const shopUser = staff === null ? await repo.findShopUserByEmail(this.db, email) : null;
    const subject = staff ?? shopUser;
    // Always run one argon2 verify so unknown users and wrong passwords take the same time.
    const valid = await argonVerify(subject?.passwordHash ?? this.dummyHash, password).catch(() => false);
    if (subject === null || !valid || !subject.active)
      return fail('INVALID_CREDENTIALS', 'invalid email or password');
    return ok(await this.issue(staff !== null ? 'staff' : 'shop_user', subject.id, randomUUID()));
  }

  async refresh(token: string | undefined): Promise<Result<Session>> {
    if (token === undefined || token.length < 20 || token.length > 200)
      return fail('TOKEN_INVALID', 'invalid refresh token');
    const now = this.clock.now();
    const row = await repo.findRefreshToken(this.db, hashToken(token));
    if (row === null) return fail('TOKEN_INVALID', 'invalid refresh token');
    if (
      row.revokedAt !== null ||
      row.usedAt !== null ||
      !(await repo.consumeRefreshToken(this.db, row.id, now))
    ) {
      await repo.revokeFamily(this.db, row.familyId, now);
      return fail('TOKEN_REUSED', 'refresh token reuse detected; session revoked');
    }
    if (row.expiresAt <= now) return fail('TOKEN_INVALID', 'refresh token expired');
    const subjectOk =
      row.subjectType === 'staff'
        ? (await repo.findStaffById(this.db, row.subjectId))?.active === true
        : (await repo.findShopUserById(this.db, row.subjectId))?.active === true;
    if (!subjectOk) return fail('TOKEN_INVALID', 'account disabled');
    return ok(await this.issue(row.subjectType as 'staff' | 'shop_user', row.subjectId, row.familyId));
  }

  async logout(token: string | undefined): Promise<void> {
    if (token === undefined) return;
    const row = await repo.findRefreshToken(this.db, hashToken(token));
    if (row !== null) await repo.revokeFamily(this.db, row.familyId, this.clock.now());
  }

  /** Resolves `Authorization: Bearer <jwt | fk_ API key>` to a principal, checked against the DB. */
  async resolveBearer(header: string | undefined): Promise<Result<Principal>> {
    const m = /^Bearer ([A-Za-z0-9._-]{10,2048})$/.exec(header ?? '');
    if (m === null || m[1] === undefined) return fail('UNAUTHENTICATED', 'authentication required');
    const token = m[1];
    const apiKey = parseApiKey(token);
    if (apiKey !== null) return this.resolveApiKey(apiKey.prefix, apiKey.key);
    if (!looksLikeJwt(token)) return fail('TOKEN_INVALID', 'invalid token');
    const claims = verifyAccessToken(token, this.env.JWT_ACCESS_SECRET, this.clock.now());
    if (claims === null || (await repo.isFamilyRevoked(this.db, claims.fam)))
      return fail('TOKEN_INVALID', 'invalid token');
    if (claims.typ === 'staff') {
      const s = await repo.findStaffById(this.db, claims.sub);
      if (s === null || !s.active) return fail('TOKEN_INVALID', 'invalid token');
      return ok({
        kind: 'staff',
        id: s.id,
        email: s.email,
        name: s.name,
        roles: s.roles.map((r) => ({ role: r.role, warehouseId: r.warehouseId })),
        familyId: claims.fam,
      });
    }
    const u = await repo.findShopUserById(this.db, claims.sub);
    if (u === null || !u.active) return fail('TOKEN_INVALID', 'invalid token');
    return ok({ kind: 'shop_user', id: u.id, shopId: u.shopId, familyId: claims.fam });
  }

  private async resolveApiKey(prefix: string, key: string): Promise<Result<Principal>> {
    const row = await repo.findApiKeyByPrefix(this.db, prefix);
    const match = apiKeyMatches(this.env.API_KEY_PEPPER, key, row?.hash ?? '0'.repeat(64));
    if (row === null || !match || row.revokedAt !== null) return fail('TOKEN_INVALID', 'invalid API key');
    return ok({ kind: 'api_key', id: row.id, shopId: row.shopId, prefix: row.prefix });
  }

  private async issue(typ: 'staff' | 'shop_user', subjectId: string, familyId: string): Promise<Session> {
    const now = this.clock.now();
    const refreshToken = newRefreshToken();
    await repo.insertRefreshToken(this.db, {
      familyId,
      subjectType: typ,
      subjectId,
      tokenHash: hashToken(refreshToken),
      expiresAt: new Date(now.getTime() + this.env.JWT_REFRESH_TTL_SEC * 1000),
      now,
    });
    const accessToken = signAccessToken(
      { sub: subjectId, typ, fam: familyId },
      this.env.JWT_ACCESS_SECRET,
      this.env.JWT_ACCESS_TTL_SEC,
      now,
    );
    const principal = await this.resolveBearer(`Bearer ${accessToken}`);
    if (!principal.ok) throw new Error('freshly issued token did not resolve');
    return { accessToken, refreshToken, expiresIn: this.env.JWT_ACCESS_TTL_SEC, principal: principal.value };
  }
}
