'use client';

import { useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { homeFor, useSession, warehousesWith } from '@/entities/session';
import { LoginForm } from '@/features/login';
import { Card, Spinner } from '@/shared/ui';

export const LoginPage = () => (
  <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center gap-4 px-4">
    <h1 className="text-2xl font-semibold">Fulfillment</h1>
    <Card title="Sign in">
      <LoginForm />
    </Card>
  </main>
);

/** Sends each signed-in user to the screen their role works in. */
export const HomePage = () => {
  const { status, me } = useSession();
  const router = useRouter();
  useEffect(() => {
    if (status === 'anonymous') router.replace('/login');
    if (status === 'authenticated' && me !== null)
      router.replace(
        homeFor(me, warehousesWith(me, ['shift_lead', 'storekeeper', 'picker', 'packer'])[0] ?? null),
      );
  }, [status, me, router]);
  return (
    <main className="p-6">
      <Spinner />
    </main>
  );
};
