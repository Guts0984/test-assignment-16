import { execFileSync } from 'node:child_process';

const PREFIXES = ['ff-adv-nginx-', 'ff-adv-redis-'] as const;

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/**
 * Safety net: remove containers left behind by aborted runs. Only containers whose owning process
 * (the pid in the name) is gone are removed, so a parallel run and the live stack are never touched.
 */
const cleanup = (): void => {
  const names = execFileSync('docker', ['ps', '-a', '--format', '{{.Names}}'], { encoding: 'utf8' })
    .split('\n')
    .filter((n) => PREFIXES.some((p) => n.startsWith(p)));
  const orphans = names.filter((n) => {
    const pid = Number(n.slice(n.lastIndexOf('-') + 1));
    return Number.isInteger(pid) && !alive(pid);
  });
  if (orphans.length > 0) execFileSync('docker', ['rm', '-f', ...orphans], { stdio: 'ignore' });
};

export const setup = (): void => cleanup();
export const teardown = (): void => cleanup();
