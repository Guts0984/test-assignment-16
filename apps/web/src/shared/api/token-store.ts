// The access token lives in memory only (never in storage); the refresh token is an httpOnly cookie.
type Listener = () => void;

const state: { token: string | null; refreshing: Promise<string | null> | null } = {
  token: null,
  refreshing: null,
};
const listeners = new Set<Listener>();

export const getAccessToken = (): string | null => state.token;
export const setAccessToken = (t: string | null): void => {
  state.token = t;
  listeners.forEach((l) => l());
};
export const onTokenChange = (l: Listener): (() => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

/** One refresh at a time, shared by every caller that needs it right now. */
export const refreshOnce = <T>(refresh: () => Promise<T | null>): Promise<T | null> => {
  const inflight = state.refreshing as Promise<T | null> | null;
  if (inflight !== null) return inflight;
  const p = refresh().finally(() => {
    state.refreshing = null;
  });
  state.refreshing = p as Promise<string | null>;
  return p;
};
