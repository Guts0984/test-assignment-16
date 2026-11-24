// Test database lifecycle: drop, recreate and migrate a dedicated test database.
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { createDb } from './client';

const PACKAGE_DIR = resolve(__dirname, '..');

export const resetTestDatabase = async (testUrl: string): Promise<void> => {
  const target = new URL(testUrl);
  const dbName = target.pathname.replace(/^\//, '');
  if (!/^[a-z0-9_]+_test$/.test(dbName)) throw new Error(`refusing to reset non-test database "${dbName}"`);
  const admin = new URL(testUrl);
  admin.pathname = '/postgres';
  const db = createDb({ url: admin.toString(), poolSize: 1 });
  try {
    await db.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
    await db.$executeRawUnsafe(`CREATE DATABASE "${dbName}"`);
  } finally {
    await db.$disconnect();
  }
  execFileSync('npx', ['prisma', 'migrate', 'deploy'], {
    cwd: PACKAGE_DIR,
    env: { ...process.env, DATABASE_URL: testUrl },
    stdio: 'pipe',
  });
};
