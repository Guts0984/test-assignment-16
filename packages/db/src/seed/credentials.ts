// Seeded demo accounts. Listed in the README; values derive from .env (plan.md A-24, A-36).
import { createHash } from 'node:crypto';
import { deriveSeedApiKey, deriveSeedWebhookSecret } from '@ff/shared/crypto/secrets';
import { type StaffRole } from '@ff/shared/domain';

/** Same as Postgres `md5(text)::uuid`, so TS and SQL agree on seeded ids. */
export const seedUuid = (text: string): string => {
  const h = createHash('md5').update(text).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
};

export const SEED_WAREHOUSES = [
  { w: 1, code: 'KYIV', slug: 'kyiv' },
  { w: 2, code: 'WAW', slug: 'warsaw' },
] as const;

export const SEED_SHOPS = [
  { s: 1, code: 'SHOP1', name: 'Green Leaf Organics', minShelfLifeDays: 30 },
  { s: 2, code: 'SHOP2', name: 'Urban Gadgets', minShelfLifeDays: 0 },
  { s: 3, code: 'SHOP3', name: 'Baby Care Plus', minShelfLifeDays: 14 },
  { s: 4, code: 'SHOP4', name: 'Pet Pantry', minShelfLifeDays: 30 },
  { s: 5, code: 'SHOP5', name: 'Home Basics', minShelfLifeDays: 7 },
] as const;

export type SeedStaff = {
  readonly email: string;
  readonly name: string;
  readonly roles: readonly { readonly role: StaffRole; readonly w: 1 | 2 | null }[];
};

const perWarehouse = (w: 1 | 2, slug: string): readonly SeedStaff[] => [
  { email: `lead.${slug}@demo.local`, name: `Shift lead ${slug}`, roles: [{ role: 'shift_lead', w }, { role: 'packer', w }] },
  { email: `store.${slug}@demo.local`, name: `Storekeeper ${slug}`, roles: [{ role: 'storekeeper', w }] },
  { email: `picker1.${slug}@demo.local`, name: `Picker 1 ${slug}`, roles: [{ role: 'picker', w }] },
  { email: `picker2.${slug}@demo.local`, name: `Picker 2 ${slug}`, roles: [{ role: 'picker', w }] },
  { email: `picker3.${slug}@demo.local`, name: `Picker 3 ${slug}`, roles: [{ role: 'picker', w }] },
  { email: `packer.${slug}@demo.local`, name: `Packer ${slug}`, roles: [{ role: 'packer', w }] },
];

export const SEED_STAFF: readonly SeedStaff[] = [
  { email: 'admin@demo.local', name: 'Administrator', roles: [{ role: 'admin', w: null }] },
  ...perWarehouse(1, 'kyiv'),
  ...perWarehouse(2, 'warsaw'),
];

export const seedShopUserEmail = (s: number): string => `shop${s}@demo.local`;

export const seedShopSecrets = (apiKeySalt: string, webhookSalt: string, code: string) => ({
  apiKey: deriveSeedApiKey(apiKeySalt, code),
  webhookSecret: deriveSeedWebhookSecret(webhookSalt, code),
});
