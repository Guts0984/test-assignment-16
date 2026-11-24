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
    expect(await ruleIds('export class Foo {}\n', 'packages/shared/src/foo.ts')).toContain(
      'no-restricted-syntax',
    );
  });

  it('allows classes in Nest construct files', async () => {
    expect(await ruleIds('export class FooService {}\n', 'apps/api/src/modules/foo/foo.service.ts')).toEqual(
      [],
    );
  });

  it('rejects process.env outside config/env.ts', async () => {
    expect(await ruleIds('export const x = process.env.FOO;\n', 'apps/api/src/modules/foo/x.ts')).toContain(
      'no-restricted-properties',
    );
    expect(await ruleIds('export const x = process.env.FOO;\n', 'apps/api/src/config/env.ts')).toEqual([]);
  });

  it('rejects default exports except Next route files', async () => {
    expect(await ruleIds('export default 1;\n', 'packages/shared/src/foo.ts')).toContain(
      'no-restricted-syntax',
    );
    expect(
      await ruleIds('export default function Page() { return null; }\n', 'apps/web/app/page.tsx'),
    ).toEqual([]);
  });

  it('rejects any and non-null assertions', async () => {
    const ids = await ruleIds('export const f = (x: any) => x!.y;\n', 'packages/shared/src/foo.ts');
    expect(ids).toContain('@typescript-eslint/no-explicit-any');
    expect(ids).toContain('@typescript-eslint/no-non-null-assertion');
  });
});

describe('Feature-Sliced Design boundaries (apps/web)', () => {
  const web = (layerFile: string, code: string) => ruleIds(code, `apps/web/src/${layerFile}`);

  it('a feature cannot import a widget or a page (upward)', async () => {
    expect(
      await web(
        'features/login/ui/x.ts',
        "import { AppShell } from '@/widgets/app-shell';\nexport const x = AppShell;\n",
      ),
    ).toContain('boundaries/element-types');
    expect(
      await web(
        'features/login/ui/x.ts',
        "import { LoginPage } from '@/pages/auth';\nexport const x = LoginPage;\n",
      ),
    ).toContain('boundaries/element-types');
  });
  it('slices of one layer cannot import each other (sideways)', async () => {
    expect(
      await web(
        'features/login/ui/x.ts',
        "import { CreateSkuForm } from '@/features/create-sku';\nexport const x = CreateSkuForm;\n",
      ),
    ).toContain('boundaries/element-types');
    expect(
      await web(
        'widgets/shop-stock/ui/x.ts',
        "import { ShopCatalog } from '@/widgets/shop-catalog';\nexport const x = ShopCatalog;\n",
      ),
    ).toContain('boundaries/element-types');
  });
  it('downward imports through a public API are fine', async () => {
    expect(
      await web(
        'features/login/ui/x.ts',
        "import { useSession } from '@/entities/session';\nexport const x = useSession;\n",
      ),
    ).toEqual([]);
    expect(
      await web(
        'widgets/shop-stock/ui/x.ts',
        "import { CancelOrderButton } from '@/features/cancel-order';\nexport const x = CancelOrderButton;\n",
      ),
    ).toEqual([]);
  });
  it('a slice is reached only through its index.ts, never its internals', async () => {
    expect(
      await web(
        'features/login/ui/x.ts',
        "import { roles } from '@/entities/session/model/roles';\nexport const x = roles;\n",
      ),
    ).toContain('boundaries/entry-point');
  });
  it('shared knows nothing of the layers above it', async () => {
    expect(
      await web(
        'shared/lib/x.ts',
        "import { useSession } from '@/entities/session';\nexport const x = useSession;\n",
      ),
    ).toContain('boundaries/element-types');
  });
});
