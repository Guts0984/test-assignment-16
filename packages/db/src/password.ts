// Password hashing in one place: argon2id with the OWASP minimum cost (19 MiB, 2 passes), which
// keeps a login in the tens of milliseconds so an in-limit flood cannot starve other users.
import { argon2id, hash, verify } from 'argon2';

const OPTIONS = { type: argon2id, memoryCost: 19_456, timeCost: 2, parallelism: 1 } as const;

export const hashPassword = (password: string): Promise<string> => hash(password, OPTIONS);

/** Never throws: a malformed stored hash is simply a failed check. */
export const verifyPassword = (stored: string, password: string): Promise<boolean> => verify(stored, password).catch(() => false);
