'use client';

import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import {
  usePickingControllerReassign,
  usePickingControllerStartWave,
} from '@/shared/api/generated/picking/picking';
import { useCountsControllerApprove, useCountsControllerCreate } from '@/shared/api/generated/counts/counts';
import { useOutboundControllerShip } from '@/shared/api/generated/packing/packing';
import { messageOf } from '@/shared/lib/form-errors';
import { newIdempotencyKey } from '@/shared/lib/scan';
import { Button, SelectInput, toast } from '@/shared/ui';

const useRefresh = () => {
  const qc = useQueryClient();
  return () => qc.invalidateQueries();
};

export const StartWaveButton = ({ warehouseId }: { warehouseId: string }) => {
  const start = useStartWave(warehouseId);
  return (
    <Button disabled={start.pending} onClick={() => void start.run()}>
      Start a wave now
    </Button>
  );
};

const useStartWave = (warehouseId: string) => {
  const m = usePickingControllerStartWave();
  const refresh = useRefresh();
  return {
    pending: m.isPending,
    run: async () => {
      try {
        const r = await m.mutateAsync({ warehouseId });
        toast(
          'ok',
          r.waveId === null ? 'No orders are ready for a wave' : `Wave started with ${r.orderCount} orders`,
        );
        await refresh();
      } catch (e) {
        toast('error', messageOf(e));
      }
    },
  };
};

export const ShipPackedButton = ({ warehouseId }: { warehouseId: string }) => {
  const ship = useOutboundControllerShip();
  const refresh = useRefresh();
  return (
    <Button
      variant="secondary"
      disabled={ship.isPending}
      onClick={async () => {
        try {
          const r = await ship.mutateAsync({ warehouseId, data: { idempotencyKey: newIdempotencyKey() } });
          toast('ok', `${r.shipped.length} orders handed to the carrier`);
          await refresh();
        } catch (e) {
          toast('error', messageOf(e));
        }
      }}
    >
      Ship packed orders for today
    </Button>
  );
};

export const ReassignControl = ({
  warehouseId,
  taskId,
  pickers,
}: {
  warehouseId: string;
  taskId: string;
  pickers: readonly { staffId: string; name: string }[];
}) => {
  const reassign = usePickingControllerReassign();
  const refresh = useRefresh();
  const [who, setWho] = useState('');
  return (
    <span className="flex items-center gap-2">
      <SelectInput aria-label="Reassign to" value={who} onChange={(e) => setWho(e.target.value)}>
        <option value="">Reassign to...</option>
        {pickers.map((p) => (
          <option key={p.staffId} value={p.staffId}>
            {p.name}
          </option>
        ))}
      </SelectInput>
      <Button
        variant="secondary"
        disabled={who === '' || reassign.isPending}
        onClick={async () => {
          try {
            await reassign.mutateAsync({ warehouseId, id: taskId, data: { pickerId: who } });
            toast('ok', 'Task reassigned');
            await refresh();
          } catch (e) {
            toast('error', messageOf(e));
          }
        }}
      >
        Reassign
      </Button>
    </span>
  );
};

export const ApproveCountButtons = ({ warehouseId, countId }: { warehouseId: string; countId: string }) => {
  const approve = useCountsControllerApprove();
  const refresh = useRefresh();
  const act = (ok: boolean) => async () => {
    try {
      await approve.mutateAsync({ warehouseId, id: countId, data: { approve: ok } });
      toast('ok', ok ? 'Adjustment approved, cell reopened' : 'Sent back for a recount');
      await refresh();
    } catch (e) {
      toast('error', messageOf(e));
    }
  };
  return (
    <span className="flex gap-2">
      <Button disabled={approve.isPending} onClick={act(true)}>
        Approve
      </Button>
      <Button variant="secondary" disabled={approve.isPending} onClick={act(false)}>
        Recount
      </Button>
    </span>
  );
};

export const OpenCountControl = ({
  warehouseId,
  cells,
}: {
  warehouseId: string;
  cells: readonly { id: string; code: string }[];
}) => {
  const create = useCountsControllerCreate();
  const refresh = useRefresh();
  const [cell, setCell] = useState('');
  return (
    <span className="flex items-center gap-2">
      <SelectInput aria-label="Cell to count" value={cell} onChange={(e) => setCell(e.target.value)}>
        <option value="">Cell to count...</option>
        {cells.map((c) => (
          <option key={c.id} value={c.id}>
            {c.code}
          </option>
        ))}
      </SelectInput>
      <Button
        disabled={cell === '' || create.isPending}
        onClick={async () => {
          try {
            await create.mutateAsync({ warehouseId, data: { cellIds: [cell] } });
            toast('ok', 'Count opened; the cell is closed for picking and putaway');
            setCell('');
            await refresh();
          } catch (e) {
            toast('error', messageOf(e));
          }
        }}
      >
        Open count
      </Button>
    </span>
  );
};
