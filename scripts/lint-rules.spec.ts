// Proves the paradigm lint rules fire: a rule that never fails is worthless.
import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';

const eslint = new ESLint({ cwd: process.cwd() });

const ruleIds = async (code: string, filePath: string): Promise<readonly string[]> => {
  const [res] = await eslint.lintText(code, { filePath });
  return (res?.messages ?? []).map((m) => m.ruleId ?? 'parse');
};

describe('paradigm lint rules', () => {
  it('rejects classes outside Nest construct files', async () => {
    expect(await ruleIds('export class Foo {}\n', 'packages/shared/src/foo.ts')).toContain('no-restricted-syntax');
  });

  it('allows classes in Nest construct files', async () => {
    expect(await ruleIds('export class FooService {}\n', 'apps/api/src/modules/foo/foo.service.ts')).toEqual([]);
  });

  it('rejects process.env outside config/env.ts', async () => {
    expect(await ruleIds('export const x = process.env.FOO;\n', 'apps/api/src/modules/foo/x.ts')).toContain(
      'no-restricted-properties',
    );
    expect(await ruleIds('export const x = process.env.FOO;\n', 'apps/api/src/config/env.ts')).toEqual([]);
  });

  it('rejects default exports except Next route files', async () => {
    expect(await ruleIds('export default 1;\n', 'packages/shared/src/foo.ts')).toContain('no-restricted-syntax');
    expect(await ruleIds('export default function Page() { return null; }\n', 'apps/web/app/page.tsx')).toEqual([]);
  });

  it('rejects any and non-null assertions', async () => {
    const ids = await ruleIds('export const f = (x: any) => x!.y;\n', 'packages/shared/src/foo.ts');
    expect(ids).toContain('@typescript-eslint/no-explicit-any');
    expect(ids).toContain('@typescript-eslint/no-non-null-assertion');
  });
});
