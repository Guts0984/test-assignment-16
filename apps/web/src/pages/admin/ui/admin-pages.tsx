'use client';

import { Suspense } from 'react';
import { AppShell } from '@/widgets/app-shell';
import { FailedJobsAdmin, ShopsAdmin, StaffAdmin, WarehousesAdmin } from '@/widgets/admin-panels';
import { Spinner } from '@/shared/ui';

const Page = ({ children }: { children: React.ReactNode }) => (
  <AppShell>
    <Suspense fallback={<Spinner />}>{children}</Suspense>
  </AppShell>
);

export const AdminWarehousesPage = () => (
  <Page>
    <WarehousesAdmin />
  </Page>
);
export const AdminShopsPage = () => (
  <Page>
    <ShopsAdmin />
  </Page>
);
export const AdminStaffPage = () => (
  <Page>
    <StaffAdmin />
  </Page>
);
export const AdminJobsPage = () => (
  <Page>
    <FailedJobsAdmin />
  </Page>
);
