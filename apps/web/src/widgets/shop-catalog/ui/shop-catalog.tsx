'use client';

import { CreateInboundForm } from '@/features/create-inbound';
import { CreateSkuForm } from '@/features/create-sku';
import { useInboundControllerList, useCatalogControllerList } from '@/shared/api/generated/shop/shop';
import { useShopWarehousesControllerList } from '@/shared/api/generated/shop/shop';
import { Card, EmptyState, Spinner, Table } from '@/shared/ui';

export const ShopCatalog = () => {
  const skus = useCatalogControllerList({ limit: 100 });
  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-xl font-semibold">Products</h1>
      <Card title="New product">
        <CreateSkuForm />
      </Card>
      <Card title="Your products">
        {skus.isLoading ? (
          <Spinner />
        ) : (skus.data?.items.length ?? 0) === 0 ? (
          <EmptyState>No products yet.</EmptyState>
        ) : (
          <Table head={['Code', 'Name', 'Barcode', 'Weight, g', 'Size, mm', 'Expiry']}>
            {skus.data?.items.map((s) => (
              <tr key={s.id}>
                <td>{s.code}</td>
                <td>{s.name}</td>
                <td>{s.barcode}</td>
                <td>{s.weightG}</td>
                <td>
                  {s.lengthMm}x{s.widthMm}x{s.heightMm}
                </td>
                <td>{s.tracksExpiry ? 'tracked' : '-'}</td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
    </div>
  );
};

export const ShopInbound = () => {
  const list = useInboundControllerList();
  const wh = useShopWarehousesControllerList();
  const warehouses = wh.data?.items ?? [];
  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-xl font-semibold">Inbound requests</h1>
      {warehouses.length > 0 && (
        <Card title="Announce a delivery">
          <CreateInboundForm warehouses={warehouses} />
        </Card>
      )}
      <Card title="Your requests and discrepancies">
        {list.isLoading ? (
          <Spinner />
        ) : (list.data?.items.length ?? 0) === 0 ? (
          <EmptyState>No inbound requests.</EmptyState>
        ) : (
          <Table head={['Reference', 'Status', 'Lines', 'Discrepancies']}>
            {list.data?.items.map((i) => (
              <tr key={i.id}>
                <td>{i.reference}</td>
                <td>{i.status}</td>
                <td>{i.lines.map((l) => `${l.skuCode} x${l.expectedQty}`).join(', ')}</td>
                <td>
                  {i.discrepancies.length === 0
                    ? '-'
                    : i.discrepancies
                        .map((d) => `${d.skuCode}: expected ${d.expectedQty}, received ${d.receivedQty}`)
                        .join('; ')}
                </td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
    </div>
  );
};
