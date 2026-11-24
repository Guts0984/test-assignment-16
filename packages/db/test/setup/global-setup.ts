import { resetTestDatabase } from '../../src/testing';

export const setup = async (): Promise<void> => {
  const url = process.env.TEST_DATABASE_URL;
  if (url === undefined) throw new Error('TEST_DATABASE_URL missing');
  await resetTestDatabase(url);
};
