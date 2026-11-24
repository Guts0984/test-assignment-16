// One stack per test process (singleFork + isolate:false keeps this module shared across spec files).
import { type Stack, startStack } from './stack';

const state: { stack: Stack | null; starting: Promise<Stack> | null } = { stack: null, starting: null };

export const ensureStack = async (): Promise<Stack> => {
  state.starting ??= startStack().then((s) => {
    state.stack = s;
    process.once('exit', () => {
      for (const w of s.workers()) w?.kill('SIGKILL');
    });
    return s;
  });
  return state.starting;
};

export const getStack = (): Stack => {
  if (state.stack === null) throw new Error('stack not started: call ensureStack() in beforeAll');
  return state.stack;
};

export const stopStack = async (): Promise<void> => {
  if (state.stack !== null) await state.stack.stopAll();
  state.stack = null;
  state.starting = null;
};
