'use client';

import { useLeadControllerDashboard } from '@/shared/api/generated/shift-lead/shift-lead';
import { useSession } from '@/entities/session';
import { StatusBadge, STATUS_LABEL } from '@/entities/order';
import { ReassignControl, ShipPackedButton, StartWaveButton } from '@/features/lead-actions';
import { formatCountdown } from '@/shared/lib/server-time';
import { useLive } from '@/shared/lib/use-live';
import { useServerNow } from '@/shared/lib/use-server-time';
import { Badge, Banner, Card, EmptyState, Spinner, Table } from '@/shared/ui';

const ORDER: readonly string[] = [
  'received',
  'awaiting_stock',
  'reserved',
  'in_wave',
  'picking',
  'picked',
  'packed',
];

/** Live view of the flow. The cutoff countdown uses the server clock, and the page re-renders on socket events. */
export const ShiftDashboard = ({ warehouseId }: { warehouseId: string }) => {
  const { token } = useSession();
  const q = useLeadControllerDashboard(warehouseId, { query: { refetchInterval: 30_000 } });
  const live = useLive(
    token,
    ['order.status', 'wave.formed', 'task.changed', 'pick.scan', 'pick.shortage', 'count.changed'],
    [[`/api/warehouses/${warehouseId}/dashboard`]],
    { warehouseId },
  );
  const now = useServerNow();
  if (q.isLoading) return <Spinner />;
  const d = q.data;
  if (d === undefined) return <Banner kind="error">Could not load the dashboard.</Banner>;
  const left = Date.parse(d.nextCutoff.at) - now;
  const pickers = d.pickers.map((p) => ({ staffId: p.staffId, name: p.name }));
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-xl font-semibold">{d.warehouse.code} - shift</h1>
        <Badge color={live === 'live' ? 'var(--ok)' : 'var(--warn)'}>
          {live === 'live' ? 'live' : 'reconnecting'}
        </Badge>
        <span className="text-sm text-[var(--muted)]" data-testid="cutoff">
          Next cutoff {d.nextCutoff.shipDay}: <strong>{formatCountdown(left)}</strong> ({d.warehouse.timeZone}
          )
        </span>
        <span className="ml-auto flex gap-2">
          <StartWaveButton warehouseId={warehouseId} />
          <ShipPackedButton warehouseId={warehouseId} />
        </span>
      </div>
      {d.countsAwaitingApproval > 0 && (
        <Banner kind="error">{d.countsAwaitingApproval} stock count(s) wait for your approval.</Banner>
      )}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-7">
        {ORDER.map((s) => (
          <Card key={s}>
            <div className="text-xs text-[var(--muted)]">{STATUS_LABEL[s]}</div>
            <div className="text-2xl font-semibold" data-testid={`count-${s}`}>
              {d.ordersByStatus[s] ?? 0}
            </div>
          </Card>
        ))}
      </div>
      <Card title={`At risk of missing the cutoff (${d.atRisk.length})`}>
        {d.atRisk.length === 0 ? (
          <EmptyState>Nothing at risk.</EmptyState>
        ) : (
          <Table head={['Order', 'Status', 'Cutoff', '']}>
            {d.atRisk.slice(0, 50).map((o) => (
              <tr key={o.orderId}>
                <td>
                  {o.orderNumber} {o.express && <Badge color="var(--accent)">express</Badge>}
                </td>
                <td>
                  <StatusBadge status={o.status} />
                </td>
                <td>
                  {o.targetCutoffAt === null ? '-' : formatCountdown(Date.parse(o.targetCutoffAt) - now)}
                </td>
                <td>{o.late && <Badge color="var(--danger)">late</Badge>}</td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Who is picking what">
          <Table head={['Picker', 'Online', 'Order', 'Progress', '']}>
            {d.pickers.map((p) => (
              <tr key={p.staffId}>
                <td>{p.name}</td>
                <td>{p.online ? <Badge color="var(--ok)">online</Badge> : <Badge>offline</Badge>}</td>
                <td>{p.orderNumber ?? '-'}</td>
                <td>{p.taskId === null ? '-' : `${p.linesDone}/${p.lines}`}</td>
                <td>
                  {p.taskId !== null && (
                    <ReassignControl
                      warehouseId={warehouseId}
                      taskId={p.taskId}
                      pickers={pickers.filter((x) => x.staffId !== p.staffId)}
                    />
                  )}
                </td>
              </tr>
            ))}
          </Table>
        </Card>
        <Card title="Latest waves">
          <Table head={['Formed', 'Trigger', 'Orders', 'Done']}>
            {d.waves.map((w) => (
              <tr key={w.id}>
                <td>{new Date(w.createdAt).toLocaleTimeString()}</td>
                <td>{w.trigger}</td>
                <td>{w.orderCount}</td>
                <td>
                  {w.tasksDone}/{w.tasks}
                </td>
              </tr>
            ))}
          </Table>
        </Card>
      </div>
    </div>
  );
};
