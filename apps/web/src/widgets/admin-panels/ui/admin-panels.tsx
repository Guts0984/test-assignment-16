'use client';

import {
  AddCellsForm,
  CreateShopForm,
  CreateStaffForm,
  CreateWarehouseForm,
  RerunJobButton,
  ShopKeyActions,
} from '@/features/admin-forms';
import {
  useAdminControllerListKeys,
  useAdminControllerListShops,
  useAdminControllerListStaff,
  useAdminControllerListWarehouses,
  useJobsAdminControllerFailed,
} from '@/shared/api/generated/admin/admin';
import { Card, EmptyState, Spinner, Table } from '@/shared/ui';

export const WarehousesAdmin = () => {
  const w = useAdminControllerListWarehouses();
  const list = w.data?.items ?? [];
  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-xl font-semibold">Warehouses</h1>
      <Card title="New warehouse">
        <CreateWarehouseForm />
      </Card>
      {list.length > 0 && (
        <Card title="Zone and cells">
          <AddCellsForm warehouses={list} />
        </Card>
      )}
      <Card title="Warehouses">
        {w.isLoading ? (
          <Spinner />
        ) : (
          <Table head={['Code', 'Name', 'Time zone', 'Cutoff', 'Working days']}>
            {list.map((x) => (
              <tr key={x.id}>
                <td>{x.code}</td>
                <td>{x.name}</td>
                <td>{x.timeZone}</td>
                <td>{x.cutoffLocal}</td>
                <td>{x.workingDays.join(', ')}</td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
    </div>
  );
};

const KeysOf = ({ shopId }: { shopId: string }) => {
  const k = useAdminControllerListKeys(shopId);
  return <ShopKeyActions shopId={shopId} keys={k.data?.items ?? []} />;
};

export const ShopsAdmin = () => {
  const s = useAdminControllerListShops();
  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-xl font-semibold">Shops</h1>
      <Card title="Connect a shop">
        <CreateShopForm />
      </Card>
      {(s.data?.items ?? []).map((shop) => (
        <Card key={shop.id} title={`${shop.code} - ${shop.name}`}>
          <p className="mb-2 text-sm text-[var(--muted)]">
            Webhook: {shop.webhookUrl} - minimum shelf life at shipment: {shop.minShelfLifeDays} days
          </p>
          <KeysOf shopId={shop.id} />
        </Card>
      ))}
    </div>
  );
};

export const StaffAdmin = () => {
  const s = useAdminControllerListStaff();
  const w = useAdminControllerListWarehouses();
  const warehouses = w.data?.items ?? [];
  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-xl font-semibold">Staff</h1>
      <Card title="New employee">
        <CreateStaffForm warehouses={warehouses} />
      </Card>
      <Card title="Employees">
        {s.isLoading ? (
          <Spinner />
        ) : (
          <Table head={['Name', 'Email', 'Active', 'Roles']}>
            {(s.data?.items ?? []).map((x) => (
              <tr key={x.id}>
                <td>{x.name}</td>
                <td>{x.email}</td>
                <td>{x.active ? 'yes' : 'no'}</td>
                <td>
                  {x.roles
                    .map(
                      (r) =>
                        `${r.role}${r.warehouseId === null ? '' : `@${warehouses.find((v) => v.id === r.warehouseId)?.code ?? ''}`}`,
                    )
                    .join(', ')}
                </td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
    </div>
  );
};

export const FailedJobsAdmin = () => {
  const j = useJobsAdminControllerFailed();
  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-xl font-semibold">Failed jobs</h1>
      <Card>
        {j.isLoading ? (
          <Spinner />
        ) : (j.data?.items.length ?? 0) === 0 ? (
          <EmptyState>No failed jobs.</EmptyState>
        ) : (
          <Table head={['Kind', 'Key', 'Attempts', 'Last error', '']}>
            {j.data?.items.map((x) => (
              <tr key={x.id}>
                <td>{x.kind}</td>
                <td className="max-w-48 truncate">{x.key}</td>
                <td>{x.attempts}</td>
                <td>{x.lastError}</td>
                <td>
                  <RerunJobButton jobId={x.id} />
                </td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
    </div>
  );
};
