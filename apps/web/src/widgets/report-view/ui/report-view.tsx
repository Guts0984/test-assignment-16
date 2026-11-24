'use client';

import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useLeadControllerReport } from '@/shared/api/generated/shift-lead/shift-lead';
import { useMyWarehouses } from '@/entities/warehouse';
import { parseReportParams, reportParamsToSearch } from '@/shared/lib/url-state';
import { useServerNow } from '@/shared/lib/use-server-time';
import { Banner, Button, Card, EmptyState, Field, SelectInput, Spinner, Table, TextInput } from '@/shared/ui';

const minutes = (m: number | null | undefined): string =>
  m === null || m === undefined ? '-' : m >= 120 ? `${(m / 60).toFixed(1)} h` : `${Math.round(m)} min`;

/** The period and filters live in the URL: reload and "Back" restore the same report. */
export const ReportView = () => {
  const sp = useSearchParams();
  const router = useRouter();
  const path = usePathname();
  const today = new Date(useServerNow(60_000)).toISOString().slice(0, 10);
  const p = parseReportParams(new URLSearchParams(sp?.toString() ?? ''), today);
  const warehouses = useMyWarehouses();
  const q = useLeadControllerReport(p);
  const set = (next: typeof p) => router.push(`${path}?${reportParamsToSearch(next)}`);
  const r = q.data;
  return (
    <div className="flex flex-col gap-4">
      <Card title="Report period">
        <form className="grid gap-3 sm:grid-cols-4" onSubmit={(e) => e.preventDefault()}>
          <Field label="From">
            {(f) => (
              <TextInput
                id={f.id}
                type="date"
                value={p.from}
                max={p.to}
                onChange={(e) => e.target.value !== '' && set({ ...p, from: e.target.value })}
              />
            )}
          </Field>
          <Field label="To">
            {(f) => (
              <TextInput
                id={f.id}
                type="date"
                value={p.to}
                min={p.from}
                onChange={(e) => e.target.value !== '' && set({ ...p, to: e.target.value })}
              />
            )}
          </Field>
          <Field label="Warehouse">
            {(f) => (
              <SelectInput
                id={f.id}
                value={p.warehouseId ?? ''}
                onChange={(e) => {
                  const { warehouseId: _drop, ...rest } = p;
                  set(e.target.value === '' ? rest : { ...rest, warehouseId: e.target.value });
                }}
              >
                <option value="">All my warehouses</option>
                {(warehouses.data?.items ?? []).map((w) => (
                  <option key={w.id} value={w.id}>
                    {w.code}
                  </option>
                ))}
              </SelectInput>
            )}
          </Field>
          <div className="flex items-end gap-2">
            {[7, 30, 90].map((d) => (
              <Button
                key={d}
                variant="secondary"
                onClick={() =>
                  set({
                    ...p,
                    from: new Date(Date.parse(`${p.to}T00:00:00Z`) - (d - 1) * 86_400_000)
                      .toISOString()
                      .slice(0, 10),
                  })
                }
              >
                {d} d
              </Button>
            ))}
          </div>
        </form>
      </Card>
      {q.isLoading && <Spinner />}
      {q.isError && <Banner kind="error">Could not build the report for this period.</Banner>}
      {r !== undefined && (
        <>
          <div className="grid gap-3 sm:grid-cols-4">
            <Card>
              <div className="text-xs text-[var(--muted)]">Shipped</div>
              <div className="text-2xl font-semibold" data-testid="shipped">
                {r.orders.shipped}
              </div>
            </Card>
            <Card>
              <div className="text-xs text-[var(--muted)]">On time</div>
              <div className="text-2xl font-semibold">
                {r.orders.onTimeRate === null ? '-' : `${Math.round(r.orders.onTimeRate * 100)}%`}
              </div>
            </Card>
            <Card>
              <div className="text-xs text-[var(--muted)]">Receipt to shipment, median</div>
              <div className="text-2xl font-semibold">{minutes(r.orders.medianMinutes)}</div>
            </Card>
            <Card>
              <div className="text-xs text-[var(--muted)]">90th percentile</div>
              <div className="text-2xl font-semibold">{minutes(r.orders.p90Minutes)}</div>
            </Card>
          </div>
          <Card title="By warehouse">
            {r.byWarehouse.length === 0 ? (
              <EmptyState>No shipped orders in this period.</EmptyState>
            ) : (
              <Table head={['Warehouse', 'Shipped', 'On time', 'Median', 'P90']}>
                {r.byWarehouse.map((w) => (
                  <tr key={w.warehouseId}>
                    <td>{w.warehouseCode}</td>
                    <td>{w.shipped}</td>
                    <td>{w.onTime}</td>
                    <td>{minutes(w.medianMinutes)}</td>
                    <td>{minutes(w.p90Minutes)}</td>
                  </tr>
                ))}
              </Table>
            )}
          </Card>
          <div className="grid gap-4 lg:grid-cols-2">
            <Card title="Shortages by employee">
              {r.shortages.length === 0 ? (
                <EmptyState>None.</EmptyState>
              ) : (
                <Table head={['Warehouse', 'Employee', 'Events', 'Units']}>
                  {r.shortages.map((s) => (
                    <tr key={`${s.warehouseId}${s.staffId}`}>
                      <td>{s.warehouseCode}</td>
                      <td>{s.staffName}</td>
                      <td>{s.events}</td>
                      <td>{s.units}</td>
                    </tr>
                  ))}
                </Table>
              )}
            </Card>
            <Card title="Adjustments by employee">
              {r.adjustments.length === 0 ? (
                <EmptyState>None.</EmptyState>
              ) : (
                <Table head={['Warehouse', 'Employee', 'Events', 'Units']}>
                  {r.adjustments.map((s) => (
                    <tr key={`${s.warehouseId}${s.staffId}`}>
                      <td>{s.warehouseCode}</td>
                      <td>{s.staffName}</td>
                      <td>{s.events}</td>
                      <td>{s.units}</td>
                    </tr>
                  ))}
                </Table>
              )}
            </Card>
          </div>
        </>
      )}
    </div>
  );
};
