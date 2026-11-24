'use client';

import { Suspense } from 'react';
import { useStockOpsControllerShops } from '@/shared/api/generated/storekeeper/storekeeper';
import { useWarehousesControllerDestinations } from '@/shared/api/generated/warehouses/warehouses';
import { MovePanel } from '@/features/move-stock';
import { PackForm } from '@/features/pack-order';
import { PickScanner } from '@/features/pick-scan';
import { PutawayPanel } from '@/features/putaway';
import { ReceivePanel } from '@/features/receive-goods';
import { AppShell } from '@/widgets/app-shell';
import { Spinner } from '@/shared/ui';

const Page = ({ warehouseId, children }: { warehouseId: string; children: React.ReactNode }) => (
  <AppShell warehouseId={warehouseId}>
    <Suspense fallback={<Spinner />}>{children}</Suspense>
  </AppShell>
);

export const PickerPage = ({ warehouseId }: { warehouseId: string }) => (
  <Page warehouseId={warehouseId}>
    <PickScanner warehouseId={warehouseId} />
  </Page>
);
export const PackerPage = ({ warehouseId }: { warehouseId: string }) => (
  <Page warehouseId={warehouseId}>
    <PackForm warehouseId={warehouseId} />
  </Page>
);
export const PutawayPage = ({ warehouseId }: { warehouseId: string }) => (
  <Page warehouseId={warehouseId}>
    <PutawayPanel warehouseId={warehouseId} />
  </Page>
);

const Receiving = ({ warehouseId }: { warehouseId: string }) => {
  const shops = useStockOpsControllerShops(warehouseId);
  if (shops.data === undefined) return <Spinner />;
  return <ReceivePanel warehouseId={warehouseId} shops={shops.data.items} />;
};
export const ReceivingPage = ({ warehouseId }: { warehouseId: string }) => (
  <Page warehouseId={warehouseId}>
    <Receiving warehouseId={warehouseId} />
  </Page>
);

const Moves = ({ warehouseId }: { warehouseId: string }) => {
  const w = useWarehousesControllerDestinations();
  return <MovePanel warehouseId={warehouseId} warehouses={w.data?.items ?? []} />;
};
export const MovesPage = ({ warehouseId }: { warehouseId: string }) => (
  <Page warehouseId={warehouseId}>
    <Moves warehouseId={warehouseId} />
  </Page>
);
