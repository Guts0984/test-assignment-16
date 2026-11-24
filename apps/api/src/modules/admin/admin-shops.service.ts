import { Inject, Injectable } from '@nestjs/common';
import { hashPassword } from '@ff/db/password';
import { type Db } from '@ff/db/client';
import { pgCode, SQLSTATE } from '@ff/db/pg-errors';
import {
  encryptSecret,
  generateApiKey,
  generateWebhookSecret,
  hashApiKey,
  parseApiKey,
} from '@ff/shared/crypto/secrets';
import { fail, ok, type Result } from '@ff/shared/result';
import { type CreateShopInput } from '@ff/shared/schemas/setup';
import { type ApiEnv } from '../../config/env';
import { CLOCK, DB, ENV } from '../../infra/tokens';
import { type Clock } from '@ff/core/clock';
import { toApiKey, toShop } from './domain/mappers';

@Injectable()
export class AdminShopsService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(ENV) private readonly env: ApiEnv,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /** The API key and webhook secret are returned once and never again. */
  async create(input: CreateShopInput) {
    const apiKey = generateApiKey();
    const webhookSecret = generateWebhookSecret();
    try {
      const shop = await this.db.$transaction(async (tx) => {
        const s = await tx.shop.create({
          data: { ...input, webhookSecretEnc: encryptSecret(this.env.WEBHOOK_SECRET_ENC_KEY, webhookSecret) },
        });
        await tx.shopApiKey.create({ data: this.keyRow(s.id, apiKey, 'initial') });
        return s;
      });
      return ok({ shop: toShop(shop), apiKey, webhookSecret });
    } catch (e) {
      if (pgCode(e) === SQLSTATE.uniqueViolation) return fail('DUPLICATE_CODE', 'shop code already exists');
      throw e;
    }
  }

  async list() {
    return { items: (await this.db.shop.findMany({ orderBy: { code: 'asc' } })).map(toShop) };
  }

  async update(id: string, patch: Partial<CreateShopInput>): Promise<Result<ReturnType<typeof toShop>>> {
    if ((await this.db.shop.count({ where: { id } })) === 0) return fail('NOT_FOUND', 'shop not found');
    await this.db.shop.updateMany({ where: { id }, data: patch });
    return ok(toShop(await this.db.shop.findUniqueOrThrow({ where: { id } })));
  }

  async createKey(shopId: string, label: string) {
    if ((await this.db.shop.count({ where: { id: shopId } })) === 0)
      return fail('NOT_FOUND', 'shop not found');
    const apiKey = generateApiKey();
    const row = await this.db.shopApiKey.create({ data: this.keyRow(shopId, apiKey, label) });
    return ok({ key: toApiKey(row), apiKey });
  }

  async listKeys(shopId: string) {
    return {
      items: (await this.db.shopApiKey.findMany({ where: { shopId }, orderBy: { createdAt: 'asc' } })).map(
        toApiKey,
      ),
    };
  }

  /** Revocation takes effect on the next request: keys are checked against the DB every time. */
  async revokeKey(shopId: string, keyId: string): Promise<Result<ReturnType<typeof toApiKey>>> {
    const n = await this.db.shopApiKey.updateMany({
      where: { id: keyId, shopId, revokedAt: null },
      data: { revokedAt: this.clock.now() },
    });
    const row = await this.db.shopApiKey.findFirst({ where: { id: keyId, shopId } });
    if (row === null) return fail('NOT_FOUND', 'API key not found');
    return n.count === 0 && row.revokedAt === null ? fail('CONFLICT', 'could not revoke') : ok(toApiKey(row));
  }

  async createUser(shopId: string, u: { email: string; name: string; password: string }) {
    if ((await this.db.shop.count({ where: { id: shopId } })) === 0)
      return fail('NOT_FOUND', 'shop not found');
    try {
      const row = await this.db.shopUser.create({
        data: {
          shopId,
          email: u.email,
          name: u.name,
          passwordHash: await hashPassword(u.password),
        },
      });
      return ok({ id: row.id, shopId: row.shopId, email: row.email, name: row.name });
    } catch (e) {
      if (pgCode(e) === SQLSTATE.uniqueViolation) return fail('DUPLICATE_EMAIL', 'email already in use');
      throw e;
    }
  }

  private keyRow(shopId: string, apiKey: string, label: string) {
    const parsed = parseApiKey(apiKey);
    if (parsed === null) throw new Error('generated API key is malformed');
    return { shopId, prefix: parsed.prefix, hash: hashApiKey(this.env.API_KEY_PEPPER, apiKey), label };
  }
}
