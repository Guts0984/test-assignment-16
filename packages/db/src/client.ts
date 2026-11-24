// PrismaClient factory: the only place a database connection is created.
import { PrismaClient, Prisma } from '@prisma/client';

export { Prisma, PrismaClient };
export type { Location, Shop, ShopApiKey, Sku, Staff, StaffRoleAssignment, Warehouse } from '@prisma/client';
export type Tx = Prisma.TransactionClient;
export type Db = PrismaClient;

export type DbOptions = {
  readonly url: string;
  readonly poolSize?: number;
  readonly poolTimeoutSec?: number;
};

const withPoolParams = (url: string, poolSize: number, poolTimeoutSec: number): string => {
  const u = new URL(url);
  if (!u.searchParams.has('connection_limit')) u.searchParams.set('connection_limit', String(poolSize));
  if (!u.searchParams.has('pool_timeout')) u.searchParams.set('pool_timeout', String(poolTimeoutSec));
  return u.toString();
};

export const createDb = (o: DbOptions): Db =>
  new PrismaClient({
    datasources: { db: { url: withPoolParams(o.url, o.poolSize ?? 20, o.poolTimeoutSec ?? 20) } },
    log: [{ emit: 'event', level: 'error' }],
  });
