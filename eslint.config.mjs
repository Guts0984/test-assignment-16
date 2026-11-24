// Repo-wide lint rules. They encode the CLAUDE.md paradigm so a violation fails CI.
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';
import globals from 'globals';
import boundaries from 'eslint-plugin-boundaries';

/** Files that hold NestJS constructs and may therefore declare classes. */
export const NEST_CLASS_FILES = [
  '**/*.module.ts',
  '**/*.controller.ts',
  '**/*.service.ts',
  '**/*.guard.ts',
  '**/*.interceptor.ts',
  '**/*.pipe.ts',
  '**/*.filter.ts',
  '**/*.gateway.ts',
  '**/*.processor.ts',
  '**/*.dto.ts',
  '**/*.provider.ts',
  '**/*.middleware.ts',
  '**/*.adapter.ts',
  '**/*.decorator.ts',
];

/** Files allowed to read process.env: env parsers, tool configs, test bootstrap, scripts. */
export const ENV_READER_FILES = [
  '**/src/config/env.ts',
  'apps/web/src/shared/config/env.ts',
  '**/*.config.{ts,mts,mjs,js,cjs}',
  '**/test/setup/**',
  '**/test/attacker/harness/**',
  'scripts/**',
  'e2e/**',
  'packages/db/src/seed/run-seed.ts',
  'packages/db/src/testing.ts',
  'apps/api/src/openapi-export.ts',
];

/** Files that must default-export (Next route files, tool configs). */
export const DEFAULT_EXPORT_FILES = [
  'apps/web/app/**/{page,layout,loading,error,not-found,template,default,global-error}.tsx',
  '**/*.config.{ts,mts,mjs,js,cjs}',
  '**/next-env.d.ts',
];

const restrictedSyntax = {
  classes: [
    { selector: 'ClassDeclaration', message: 'Classes are only allowed for NestJS constructs (see CLAUDE.md).' },
    { selector: 'ClassExpression', message: 'Classes are only allowed for NestJS constructs (see CLAUDE.md).' },
  ],
  defaultExport: [{ selector: 'ExportDefaultDeclaration', message: 'Use named exports.' }],
};


// Feature-Sliced Design for apps/web/src: a layer may import only from layers below it, never
// sideways between slices of one layer, and a slice only through its index.ts (CLAUDE.md).
const WEB = 'apps/web/src';
const fsdElements = [
  { type: 'app', pattern: `${WEB}/app`, mode: 'folder' },
  { type: 'pages', pattern: `${WEB}/pages/*`, mode: 'folder', capture: ['slice'] },
  { type: 'widgets', pattern: `${WEB}/widgets/*`, mode: 'folder', capture: ['slice'] },
  { type: 'features', pattern: `${WEB}/features/*`, mode: 'folder', capture: ['slice'] },
  { type: 'entities', pattern: `${WEB}/entities/*`, mode: 'folder', capture: ['slice'] },
  { type: 'shared', pattern: `${WEB}/shared`, mode: 'folder' },
];
const own = (layer) => [layer, { slice: '${from.slice}' }];
export const fsdConfig = {
  files: [`${WEB}/**/*.{ts,tsx}`],
  ignores: [`${WEB}/shared/api/generated/**`],
  plugins: { boundaries },
  settings: {
    'boundaries/elements': fsdElements,
    'boundaries/ignore': ['**/*.spec.{ts,tsx}'],
    'import/resolver': { typescript: { project: 'apps/web/tsconfig.json' } },
  },
  rules: {
    'boundaries/element-types': [
      'error',
      {
        default: 'disallow',
        rules: [
          { from: 'app', allow: ['app', 'pages', 'widgets', 'features', 'entities', 'shared'] },
          { from: 'pages', allow: [own('pages'), 'widgets', 'features', 'entities', 'shared'] },
          { from: 'widgets', allow: [own('widgets'), 'features', 'entities', 'shared'] },
          { from: 'features', allow: [own('features'), 'entities', 'shared'] },
          { from: 'entities', allow: [own('entities'), 'shared'] },
          { from: 'shared', allow: ['shared'] },
        ],
      },
    ],
    'boundaries/entry-point': [
      'error',
      {
        default: 'disallow',
        rules: [
          { target: ['pages', 'widgets', 'features', 'entities'], allow: 'index.ts' },
          { target: ['app', 'shared'], allow: '**' },
        ],
      },
    ],
  },
};

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/.next/**',
      '**/coverage/**',
      '**/generated/**',
      '**/playwright-report/**',
      '**/test-results/**',
      'scripts/lint-fixtures/**',
      '**/next-env.d.ts',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  prettier,
  {
    languageOptions: { globals: { ...globals.node }, ecmaVersion: 2023, sourceType: 'module' },
    linterOptions: { reportUnusedDisableDirectives: 'error' },
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-non-null-assertion': 'error',
      '@typescript-eslint/ban-ts-comment': ['error', { 'ts-ignore': 'allow-with-description', 'ts-expect-error': 'allow-with-description' }],
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/consistent-type-imports': ['error', { fixStyle: 'inline-type-imports', disallowTypeAnnotations: false }],
      'no-console': 'error',
      'no-restricted-syntax': ['error', ...restrictedSyntax.classes, ...restrictedSyntax.defaultExport],
      'no-restricted-properties': [
        'error',
        { object: 'process', property: 'env', message: 'Read configuration from src/config/env.ts only.' },
      ],
    },
  },
  {
    files: NEST_CLASS_FILES,
    rules: {
      'no-restricted-syntax': ['error', ...restrictedSyntax.defaultExport],
      // Nest injects class-typed constructor parameters through emitted metadata.
      '@typescript-eslint/consistent-type-imports': 'off',
    },
  },
  {
    files: DEFAULT_EXPORT_FILES,
    rules: { 'no-restricted-syntax': ['error', ...restrictedSyntax.classes] },
  },
  {
    files: ENV_READER_FILES,
    rules: { 'no-restricted-properties': 'off' },
  },
  fsdConfig,
  {
    files: ['scripts/**', 'e2e/**', '**/test/**'],
    // Tests read untyped JSON bodies from a real server.
    rules: { 'no-console': 'off', '@typescript-eslint/no-explicit-any': 'off' },
  },
);
