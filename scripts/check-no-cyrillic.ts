// Fails when any tracked or new text file outside ASSIGNMENT.md contains Cyrillic.
// Rule: English everywhere, Russian only in ASSIGNMENT.md (plan.md A-1).
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const ALLOWED = new Set(['ASSIGNMENT.md']);
const CYRILLIC = new RegExp(`[${String.fromCodePoint(0x400)}-${String.fromCodePoint(0x4ff)}]`, 'u');
const BINARY = /\.(png|jpe?g|gif|ico|pdf|woff2?|ttf|lock)$/i;

const listFiles = (): readonly string[] =>
  execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], { encoding: 'utf8' })
    .split('\n')
    .filter((f) => f.length > 0 && !ALLOWED.has(f) && !BINARY.test(f) && f !== 'pnpm-lock.yaml');

const offenders = listFiles().flatMap((file) => {
  const text = (() => {
    try {
      return readFileSync(file, 'utf8');
    } catch {
      return '';
    }
  })();
  return text
    .split('\n')
    .map((line, i) => ({ file, line: i + 1, hit: CYRILLIC.test(line) }))
    .filter((r) => r.hit);
});

if (offenders.length > 0) {
  for (const o of offenders) console.error(`Cyrillic text in ${o.file}:${o.line}`);
  process.exit(1);
}
console.log('check-no-cyrillic: ok');
