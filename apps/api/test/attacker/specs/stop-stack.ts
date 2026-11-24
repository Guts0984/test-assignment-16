// Imported first: afterAll hooks run in reverse order of registration, so this one runs after every
// other hook of the combined suite and tears the stack down last.
import { afterAll } from 'vitest';
import { stopStack } from '../harness/global';

afterAll(async () => {
  await stopStack();
});
