import { resetTestDatabase } from '@ff/db/testing';

export const setup = async (): Promise<void> => {
  const url = process.env.DATABASE_URL;
  if (url === undefined || url === '') throw new Error('DATABASE_URL missing for integration tests');
  await resetTestDatabase(url);
};
