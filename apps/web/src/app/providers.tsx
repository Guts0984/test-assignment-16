'use client';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { type ReactNode, useState } from 'react';
import { SessionProvider } from '@/entities/session';
import { ToastHost } from '@/shared/ui';

export const Providers = ({ children }: { children: ReactNode }) => {
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: { queries: { staleTime: 5_000, retry: 1, refetchOnWindowFocus: true } },
      }),
  );
  return (
    <QueryClientProvider client={client}>
      <SessionProvider>
        {children}
        <ToastHost />
      </SessionProvider>
    </QueryClientProvider>
  );
};
