import { execFileSync } from 'node:child_process';

/** Safety net: remove any nginx container left behind by an aborted run. */
const cleanup = (): void => {
  const ids = execFileSync('docker', ['ps', '-aq', '--filter', 'name=ff-adv-nginx'], { encoding: 'utf8' })
    .split('\n')
    .filter((x) => x !== '');
  if (ids.length > 0) execFileSync('docker', ['rm', '-f', ...ids], { stdio: 'ignore' });
};

export const setup = (): void => cleanup();
export const teardown = (): void => cleanup();
