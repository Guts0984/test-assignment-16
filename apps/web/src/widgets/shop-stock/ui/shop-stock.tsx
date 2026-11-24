'use client';

import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useSession } from '@/entities/session';
import { useShopStockControllerList } from '@/shared/api/generated/shop/shop';
import { listParamsToSearch, parseListParams } from '@/shared/lib/url-state';
import { useLive } from '@/shared/lib/use-live';
import { Badge, Banner, Card, EmptyState, Field, Spinner, Table, TextInput } from '@/shared/ui';

/** Stock per SKU per warehouse: on the shelf, reserved, available, in transit. Updates live. */
export const ShopStock = () => {
  const { token } = useSession();
  const sp = useSearchParams();
  const router = useRouter();
  const path = usePathname();
  const params = parseListParams(new URLSearchParams(sp?.toString() ?? ''));
  const q = useShopStockControllerList({
    ...(params.q === '' ? {} : { q: params.q }),
    ...(params.cursor === '' ? {} : { cursor: params.cursor }),
    limit: 25,
  });
  const live = useLive(token, ['stock.changed'], [['/api/shop/v1/stock']]);
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <h1 className="text-xl font-semibold">Stock by warehouse</h1>
        <Badge color={live === 'live' ? 'var(--ok)' : 'var(--warn)'}>
          {live === 'live' ? 'live' : 'reconnecting'}
        </Badge>
      </div>
      <Card>
        <Field label="Search by code, barcode or name">
          {(f) => (
            <TextInput
              id={f.id}
              defaultValue={params.q}
              onChange={(e) => router.replace(`${path}?${listParamsToSearch({ q: e.target.value })}`)}
            />
          )}
        </Field>
      </Card>
      {q.isLoading && <Spinner />}
      {q.isError && <Banner kind="error">Could not load stock.</Banner>}
      {q.data !== undefined &&
        (q.data.items.length === 0 ? (
          <EmptyState>No products match.</EmptyState>
        ) : (
          <Card>
            <Table head={['SKU', 'Warehouse', 'On shelf', 'Reserved', 'Available', 'In transit', 'On dock']}>
              {q.data.items.flatMap((s) =>
                s.warehouses.map((w) => (
                  <tr
                    key={`${s.skuId}${w.warehouseId}`}
                    data-testid={`stock-${s.skuCode}-${w.warehouseCode}`}
                  >
                    <td>
                      {s.skuCode} <span className="text-[var(--muted)]">{s.skuName}</span>
                    </td>
                    <td>{w.warehouseCode}</td>
                    <td>{w.onShelf}</td>
                    <td>{w.reserved}</td>
                    <td>
                      <strong>{w.available}</strong>
                    </td>
                    <td>{w.inTransit}</td>
                    <td>{w.receiving}</td>
                  </tr>
                )),
              )}
            </Table>
            {q.data.nextCursor !== null && (
              <button
                className="mt-3 text-sm underline"
                onClick={() =>
                  router.push(
                    `${path}?${listParamsToSearch({ q: params.q, cursor: q.data?.nextCursor ?? '' })}`,
                  )
                }
              >
                Next page
              </button>
            )}
          </Card>
        ))}
    </div>
  );
};
