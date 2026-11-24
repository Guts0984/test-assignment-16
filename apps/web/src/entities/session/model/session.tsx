'use client';

import { useQueryClient } from '@tanstack/react-query';
import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { authControllerLogin, authControllerLogout } from '@/shared/api/generated/auth/auth';
import type { MeDto } from '@/shared/api/generated/model';
import { refreshSession } from '@/shared/api/mutator';
import { getAccessToken, setAccessToken } from '@/shared/api/token-store';

export type Me = MeDto;
type Status = 'loading' | 'anonymous' | 'authenticated';
type Ctx = {
  readonly status: Status;
  readonly me: Me | null;
  readonly token: string | null;
  readonly login: (email: string, password: string) => Promise<void>;
  readonly logout: () => Promise<void>;
};

const SessionContext = createContext<Ctx | null>(null);

export const SessionProvider = ({ children }: { children: ReactNode }) => {
  const qc = useQueryClient();
  const [state, setState] = useState<{ status: Status; me: Me | null; token: string | null }>({
    status: 'loading',
    me: null,
    token: null,
  });

  // Restore the session from the httpOnly refresh cookie on first load.
  useEffect(() => {
    let alive = true;
    refreshSession()
      .then((s) => {
        if (s === null) throw new Error('no session');
        setAccessToken(s.accessToken);
        if (alive) setState({ status: 'authenticated', me: s.me as Me, token: s.accessToken });
      })
      .catch(() => alive && setState({ status: 'anonymous', me: null, token: null }));
    return () => {
      alive = false;
    };
  }, []);

  const login = useCallback(async (email: string, password: string) => {
    const s = await authControllerLogin({ email, password });
    setAccessToken(s.accessToken);
    setState({ status: 'authenticated', me: s.me, token: s.accessToken });
  }, []);

  const logout = useCallback(async () => {
    await authControllerLogout({}).catch(() => undefined);
    setAccessToken(null);
    qc.clear();
    setState({ status: 'anonymous', me: null, token: null });
  }, [qc]);

  const value = useMemo(
    () => ({ ...state, token: state.token ?? getAccessToken(), login, logout }),
    [state, login, logout],
  );
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
};

export const useSession = (): Ctx => {
  const c = useContext(SessionContext);
  if (c === null) throw new Error('useSession outside SessionProvider');
  return c;
};
