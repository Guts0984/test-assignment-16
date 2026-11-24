'use client';

import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { StatusBadge, STATUS_LABEL } from '@/entities/order';
import { useSession } from '@/entities/session';
import { CancelOrderButton } from '@/features/cancel-order';
import { useShopOrdersControllerGet, useShopOrdersControllerList } from '@/shared/api/generated/shop/shop';
import {
  useStaffOrdersControllerGet,
  useStaffOrdersControllerSearch,
} from '@/shared/api/generated/orders/orders';
import { listParamsToSearch, parseListParams } from '@/shared/lib/url-state';
import { useLive } from '@/shared/lib/use-live';
import { Banner, Card, EmptyState, Field, SelectInput, Spinner, Table, TextInput } from '@/shared/ui';

type Mode = { readonly kind: 'shop' } | { readonly kind: 'staff'; readonly warehouseId: string };

/** Order search by number, customer or SKU; query, status and page are kept in the URL. */
export const OrdersList = ({ mode, base }: { mode: Mode; base: string }) => {
  const { token } = useSession();
  const sp = useSearchParams();
  const router = useRouter();
  const path = usePathname();
  const p = parseListParams(new URLSearchParams(sp?.toString() ?? ''));
  const args = {
    ...(p.q === '' ? {} : { q: p.q }),
    ...(p.status === '' ? {} : { status: p.status as never }),
    ...(p.cursor === '' ? {} : { cursor: p.cursor }),
    limit: 25,
  };
  const shop = useShopOrdersControllerList(args, { query: { enabled: mode.kind === 'shop' } });
  const staff = useStaffOrdersControllerSearch(
    { ...args, ...(mode.kind === 'staff' ? { warehouseId: mode.warehouseId } : {}) },
    { query: { enabled: mode.kind === 'staff' } },
  );
  const q = mode.kind === 'shop' ? shop : staff;
  useLive(
    token,
    ['order.status'],
    [[mode.kind === 'shop' ? '/api/shop/v1/orders' : '/api/orders']],
    mode.kind === 'staff' ? { warehouseId: mode.warehouseId } : undefined,
  );
  const go = (next: Partial<typeof p>) =>
    router.push(`${path}?${listParamsToSearch({ ...p, cursor: '', ...next })}`);
  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-xl font-semibold">Orders</h1>
      <Card>
        <form className="grid gap-3 sm:grid-cols-3" onSubmit={(e) => e.preventDefault()}>
          <Field label="Order number, customer or SKU">
            {(f) => (
              <TextInput
                id={f.id}
                defaultValue={p.q}
                onChange={(e) =>
                  router.replace(`${path}?${listParamsToSearch({ ...p, q: e.target.value, cursor: '' })}`)
                }
              />
            )}
          </Field>
          <Field label="Status">
            {(f) => (
              <SelectInput id={f.id} value={p.status} onChange={(e) => go({ status: e.target.value })}>
                <option value="">All</option>
                {Object.entries(STATUS_LABEL).map(([k, v]) => (
                  <option key={k} value={k}>
                    {v}
                  </option>
                ))}
              </SelectInput>
            )}
          </Field>
        </form>
      </Card>
      {q.isLoading && <Spinner />}
      {q.isError && <Banner kind="error">Could not load orders.</Banner>}
      {q.data !== undefined &&
        (q.data.items.length === 0 ? (
          <EmptyState>No orders found.</EmptyState>
        ) : (
          <Card>
            <Table head={['Order', 'Customer', 'Status', 'Delivery', 'Received', 'Ship day']}>
              {q.data.items.map((o) => (
                <tr key={o.id}>
                  <td>
                    <Link className="underline" href={`${base}/${o.id}`}>
                      {o.externalNumber}
                    </Link>
                  </td>
                  <td>{o.customerName}</td>
                  <td>
                    <StatusBadge status={o.status} />
                  </td>
                  <td>{o.deliveryMethod}</td>
                  <td>{new Date(o.receivedAt).toLocaleString()}</td>
                  <td>{o.shipDay ?? '-'}</td>
                </tr>
              ))}
            </Table>
            {q.data.nextCursor !== null && (
              <button
                className="mt-3 text-sm underline"
                onClick={() =>
                  router.push(`${path}?${listParamsToSearch({ ...p, cursor: q.data?.nextCursor ?? '' })}`)
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

export const OrderDetail = ({ id, mode }: { id: string; mode: Mode }) => {
  const { token } = useSession();
  const shop = useShopOrdersControllerGet(id, { query: { enabled: mode.kind === 'shop' } });
  const staff = useStaffOrdersControllerGet(id, { query: { enabled: mode.kind === 'staff' } });
  const q = mode.kind === 'shop' ? shop : staff;
  useLive(
    token,
    ['order.status'],
    [[`/api/${mode.kind === 'shop' ? 'shop/v1/' : ''}orders/${id}`]],
    mode.kind === 'staff' ? { warehouseId: mode.warehouseId } : undefined,
  );
  if (q.isLoading) return <Spinner />;
  const o = q.data;
  if (o === undefined) return <Banner kind="error">Order not found.</Banner>;
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-xl font-semibold">Order {o.externalNumber}</h1>
        <StatusBadge status={o.status} />
        {mode.kind === 'shop' && (
          <span className="ml-auto">
            <CancelOrderButton orderId={o.id} status={o.status} />
          </span>
        )}
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Lines">
          <Table head={['SKU', 'Qty', 'Reserved', 'Picked']}>
            {o.lines.map((l) => (
              <tr key={l.id}>
                <td>{l.skuCode}</td>
                <td>{l.qty}</td>
                <td>{l.reservedQty}</td>
                <td>{l.pickedQty}</td>
              </tr>
            ))}
          </Table>
        </Card>
        <Card title="Delivery">
          <p className="text-sm">
            {o.customerName}
            <br />
            {String(o.address.line1 ?? '')}, {String(o.address.postalCode ?? '')}{' '}
            {String(o.address.city ?? '')}
            <br />
            {o.deliveryMethod}
            {o.warehouseCode !== null && ` from ${o.warehouseCode}`}
            {o.shipDay !== null && `, ships ${o.shipDay}`}
          </p>
        </Card>
      </div>
      <Card title="History">
        <Table head={['#', 'From', 'To', 'By', 'When']}>
          {o.history.map((h) => (
            <tr key={h.version}>
              <td>{h.version}</td>
              <td>{h.from === null ? '-' : STATUS_LABEL[h.from]}</td>
              <td>{STATUS_LABEL[h.to]}</td>
              <td>{h.actorType}</td>
              <td>{new Date(h.at).toLocaleString()}</td>
            </tr>
          ))}
        </Table>
      </Card>
    </div>
  );
};
