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

/** One refresh at a time, shared by every request that hit a 401. */
export const refreshAccessToken = (refresh: () => Promise<string | null>): Promise<string | null> => {
  state.refreshing ??= refresh().finally(() => {
    state.refreshing = null;
  });
  return state.refreshing;
};
