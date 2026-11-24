'use client';

import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useSession } from '@/entities/session';
import { ApproveCountButtons, OpenCountControl } from '@/features/lead-actions';
import {
  useCountsControllerContents,
  useCountsControllerGet,
  useCountsControllerList,
  useCountsControllerSubmit,
} from '@/shared/api/generated/counts/counts';
import { useWarehousesControllerCells } from '@/shared/api/generated/warehouses/warehouses';
import { messageOf } from '@/shared/lib/form-errors';
import { newIdempotencyKey } from '@/shared/lib/scan';
import { useLive } from '@/shared/lib/use-live';
import {
  Badge,
  Banner,
  Button,
  Card,
  EmptyState,
  Field,
  Spinner,
  Table,
  TextInput,
  toast,
} from '@/shared/ui';

const CountEntry = ({ warehouseId, id }: { warehouseId: string; id: string }) => {
  const qc = useQueryClient();
  const contents = useCountsControllerContents(warehouseId, id);
  const submit = useCountsControllerSubmit();
  const [qty, setQty] = useState<Record<string, string>>({});
  const [reason, setReason] = useState<Record<string, string>>({});
  const [err, setErr] = useState<Record<string, string>>({});
  if (contents.data === undefined) return <Spinner />;
  const items = contents.data.items;
  return (
    <form
      className="flex flex-col gap-3"
      noValidate
      onSubmit={async (e) => {
        e.preventDefault();
        const next: Record<string, string> = {};
        const lines = items.map((i) => {
          const k = `${i.skuId}/${i.batchId}`;
          const counted = Number(qty[k] ?? i.systemQty);
          if (!Number.isInteger(counted) || counted < 0) next[k] = 'Enter a whole number, 0 or more';
          else if (counted !== i.systemQty && (reason[k] ?? '').trim() === '')
            next[k] = 'A reason is required for every difference';
          return {
            skuId: i.skuId,
            batchId: i.batchId,
            countedQty: counted,
            ...((reason[k] ?? '') !== '' ? { reason: reason[k] } : {}),
          };
        });
        setErr(next);
        if (Object.keys(next).length > 0) return;
        try {
          await submit.mutateAsync({ warehouseId, id, data: { lines, idempotencyKey: newIdempotencyKey() } });
          toast('ok', 'Count submitted');
          await qc.invalidateQueries();
        } catch (er) {
          setErr({ banner: messageOf(er) });
        }
      }}
    >
      {err.banner !== undefined && <Banner kind="error">{err.banner}</Banner>}
      {items.length === 0 && (
        <EmptyState>The system shows nothing in this cell. Submit to confirm it is empty.</EmptyState>
      )}
      {items.map((i) => {
        const k = `${i.skuId}/${i.batchId}`;
        return (
          <div key={k} className="grid gap-2 sm:grid-cols-4">
            <div className="self-center text-sm">
              <strong>{i.skuCode}</strong> {i.skuName}
              <br />
              batch {i.batchCode} - system {i.systemQty}
            </div>
            <Field label="Counted" error={err[k]}>
              {(f) => (
                <TextInput
                  id={f.id}
                  type="number"
                  min={0}
                  invalid={f.invalid}
                  aria-describedby={f.describedBy}
                  value={qty[k] ?? String(i.systemQty)}
                  onChange={(e) => setQty({ ...qty, [k]: e.target.value })}
                />
              )}
            </Field>
            <Field label="Reason">
              {(f) => (
                <TextInput
                  id={f.id}
                  value={reason[k] ?? ''}
                  onChange={(e) => setReason({ ...reason, [k]: e.target.value })}
                />
              )}
            </Field>
          </div>
        );
      })}
      <div>
        <Button type="submit" disabled={submit.isPending}>
          Submit count
        </Button>
      </div>
    </form>
  );
};

const CountDetail = ({
  warehouseId,
  id,
  canApprove,
}: {
  warehouseId: string;
  id: string;
  canApprove: boolean;
}) => {
  const q = useCountsControllerGet(warehouseId, id);
  if (q.data === undefined) return <Spinner />;
  const c = q.data;
  return (
    <Card title={`Count of ${c.cellCode} (${c.status})`}>
      {c.status === 'pending_approval' && (
        <div className="flex flex-col gap-3">
          <Table head={['SKU/batch', 'System', 'Counted', 'Difference', 'Reason']}>
            {c.lines.map((l) => (
              <tr key={`${l.skuId}${l.batchId}`}>
                <td>
                  {l.skuId.slice(0, 8)}/{l.batchId.slice(0, 6)}
                </td>
                <td>{l.systemQty}</td>
                <td>{l.countedQty}</td>
                <td>
                  {l.delta}
                  {l.requiresApproval && (
                    <>
                      {' '}
                      <Badge color="var(--warn)">needs approval</Badge>
                    </>
                  )}
                </td>
                <td>{l.reason}</td>
              </tr>
            ))}
          </Table>
          {canApprove && <ApproveCountButtons warehouseId={warehouseId} countId={c.id} />}
        </div>
      )}
      {c.status === 'open' && <CountEntry warehouseId={warehouseId} id={c.id} />}
    </Card>
  );
};

/** Stock counts: open, follow and approve. A discrepancy over 5 units or 10% waits for the shift lead. */
export const CountsPanel = ({ warehouseId, isLead }: { warehouseId: string; isLead: boolean }) => {
  const { token } = useSession();
  const list = useCountsControllerList(warehouseId);
  const cells = useWarehousesControllerCells(warehouseId, { limit: 500 }, { query: { enabled: isLead } });
  useLive(token, ['count.changed'], [[`/api/warehouses/${warehouseId}/counts`]], { warehouseId });
  const [open, setOpen] = useState<string | null>(null);
  if (list.isLoading) return <Spinner />;
  const items = list.data?.items ?? [];
  return (
    <div className="flex flex-col gap-4">
      {isLead && (
        <Card title="Open a count">
          <OpenCountControl
            warehouseId={warehouseId}
            cells={(cells.data?.items ?? []).filter((c) => c.kind === 'storage' && c.blockedReason === null)}
          />
        </Card>
      )}
      <Card title="Open counts">
        {items.length === 0 ? (
          <EmptyState>No counts are open.</EmptyState>
        ) : (
          <Table head={['Cell', 'Status', 'Origin', '']}>
            {items.map((c) => (
              <tr key={c.id}>
                <td>{c.cellCode}</td>
                <td>
                  {c.status === 'pending_approval' ? (
                    <Badge color="var(--warn)">needs approval</Badge>
                  ) : (
                    c.status
                  )}
                </td>
                <td>{c.origin}</td>
                <td>
                  <Button variant="secondary" onClick={() => setOpen(c.id)}>
                    Open
                  </Button>
                </td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
      {open !== null && <CountDetail warehouseId={warehouseId} id={open} canApprove={isLead} />}
    </div>
  );
};
