// The HTTP layer under the generated client: base URL, bearer token, one refresh-and-retry on 401,
// JSON in/out, and the shared error body surfaced as ApiError.
import { publicEnv } from '../config/env';
import { getAccessToken, refreshOnce, setAccessToken } from './token-store';

export type ApiErrorBody = {
  readonly code: string;
  readonly message: string;
  readonly fields?: readonly { readonly path: string; readonly code: string; readonly message: string }[];
  readonly details?: Readonly<Record<string, unknown>>;
};

export type ApiError = Error & { readonly status: number; readonly body: ApiErrorBody };

export const isApiError = (e: unknown): e is ApiError =>
  e instanceof Error &&
  typeof (e as { status?: unknown }).status === 'number' &&
  typeof (e as { body?: unknown }).body === 'object';

const makeError = (status: number, body: ApiErrorBody): ApiError =>
  Object.assign(new Error(body.message), { status, body });

const send = async (url: string, init: RequestInit, token: string | null): Promise<Response> => {
  const headers = new Headers(init.headers);
  if (token !== null) headers.set('authorization', `Bearer ${token}`);
  if (init.body !== undefined && init.body !== null && !headers.has('content-type'))
    headers.set('content-type', 'application/json');
  // Generated paths already carry the global /api prefix; the base URL decides where it is served.
  return fetch(`${publicEnv.NEXT_PUBLIC_API_BASE_URL}${url.replace(/^\/api/, '')}`, {
    ...init,
    headers,
    credentials: 'include',
  });
};

type RefreshedSession = { readonly accessToken: string; readonly me: unknown };

const requestRefresh = async (): Promise<RefreshedSession | null> => {
  const r = await fetch(`${publicEnv.NEXT_PUBLIC_API_BASE_URL}/auth/refresh`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
    credentials: 'include',
  });
  return r.ok ? ((await r.json()) as RefreshedSession) : null;
};

/**
 * Restores a session from the refresh cookie. The session restore and every request that hit a 401
 * share ONE in-flight call: a rotating refresh token can be used once, and a second parallel use
 * would look like token theft and end the session.
 */
export const refreshSession = (): Promise<RefreshedSession | null> => refreshOnce(requestRefresh);

/** Called by every generated operation; resolves with the parsed body, rejects with ApiError. */
export const apiFetch = async <T>(url: string, init: RequestInit = {}): Promise<T> => {
  let res = await send(url, init, getAccessToken());
  if (res.status === 401 && !url.startsWith('/api/auth/')) {
    const fresh = await refreshSession();
    setAccessToken(fresh?.accessToken ?? null);
    if (fresh !== null) res = await send(url, init, fresh.accessToken);
  }
  const text = await res.text();
  const parsed: unknown =
    text === ''
      ? null
      : (() => {
          try {
            return JSON.parse(text) as unknown;
          } catch {
            return text;
          }
        })();
  if (!res.ok) {
    const body = (parsed as { error?: ApiErrorBody } | null)?.error ?? {
      code: 'UNEXPECTED',
      message: `request failed (${res.status})`,
    };
    throw makeError(res.status, body);
  }
  return parsed as T;
};
