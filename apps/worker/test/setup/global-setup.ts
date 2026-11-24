import { resetTestDatabase } from '@ff/db/testing';
import { testEnv } from './test-env';

export const setup = async (): Promise<void> => {
  await resetTestDatabase(testEnv.DATABASE_URL);
};
