'use client';

import { Suspense } from 'react';
import { hasRole, useSession } from '@/entities/session';
import { AppShell } from '@/widgets/app-shell';
import { CountsPanel } from '@/widgets/counts-panel';
import { OrderDetail, OrdersList } from '@/widgets/orders-view';
import { ReportView } from '@/widgets/report-view';
import { ShiftDashboard } from '@/widgets/shift-dashboard';
import { Spinner } from '@/shared/ui';

const Page = ({ warehouseId, children }: { warehouseId: string; children: React.ReactNode }) => (
  <AppShell warehouseId={warehouseId}>
    <Suspense fallback={<Spinner />}>{children}</Suspense>
  </AppShell>
);

export const LeadDashboardPage = ({ warehouseId }: { warehouseId: string }) => (
  <Page warehouseId={warehouseId}>
    <ShiftDashboard warehouseId={warehouseId} />
  </Page>
);
export const LeadReportPage = ({ warehouseId }: { warehouseId: string }) => (
  <Page warehouseId={warehouseId}>
    <ReportView />
  </Page>
);
export const LeadOrdersPage = ({ warehouseId }: { warehouseId: string }) => (
  <Page warehouseId={warehouseId}>
    <OrdersList mode={{ kind: 'staff', warehouseId }} base={`/w/${warehouseId}/orders`} />
  </Page>
);
export const LeadOrderPage = ({ warehouseId, id }: { warehouseId: string; id: string }) => (
  <Page warehouseId={warehouseId}>
    <OrderDetail id={id} mode={{ kind: 'staff', warehouseId }} />
  </Page>
);

const Counts = ({ warehouseId }: { warehouseId: string }) => {
  const { me } = useSession();
  return <CountsPanel warehouseId={warehouseId} isLead={me !== null && hasRole(me, ['shift_lead'])} />;
};
export const LeadCountsPage = ({ warehouseId }: { warehouseId: string }) => (
  <Page warehouseId={warehouseId}>
    <Counts warehouseId={warehouseId} />
  </Page>
);
