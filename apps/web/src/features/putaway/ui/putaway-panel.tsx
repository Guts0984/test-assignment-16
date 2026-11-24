'use client';

import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import {
  useStockOpsControllerConfirm,
  useStockOpsControllerPending,
  useStockOpsControllerSuggest,
} from '@/shared/api/generated/storekeeper/storekeeper';
import type { PendingPutawayDtoItemsItem } from '@/shared/api/generated/model';
import { codeOf, messageOf } from '@/shared/lib/form-errors';
import { newIdempotencyKey, normalizeScan } from '@/shared/lib/scan';
import { playBeep } from '@/shared/lib/sound';
import { Banner, Button, Card, EmptyState, Field, Spinner, TextInput, toast } from '@/shared/ui';

/** Putaway: the system suggests a cell; the storekeeper scans the cell and confirms. */
export const PutawayPanel = ({ warehouseId }: { warehouseId: string }) => {
  const qc = useQueryClient();
  const pending = useStockOpsControllerPending(warehouseId);
  const suggest = useStockOpsControllerSuggest();
  const confirm = useStockOpsControllerConfirm();
  const [picked, setPicked] = useState<PendingPutawayDtoItemsItem | null>(null);
  const [suggestions, setSuggestions] = useState<readonly { cellId: string; code: string; reason: string }[]>(
    [],
  );
  const [cell, setCell] = useState('');
  const [qty, setQty] = useState('1');
  const [error, setError] = useState<string | null>(null);

  const choose = async (item: PendingPutawayDtoItemsItem) => {
    setPicked(item);
    setQty(String(item.qty));
    setCell('');
    setError(null);
    const r = await suggest
      .mutateAsync({
        warehouseId,
        data: {
          sourceLocationId: item.sourceLocationId,
          skuId: item.skuId,
          batchId: item.batchId,
          qty: item.qty,
        },
      })
      .catch(() => null);
    setSuggestions(r?.items ?? []);
    if (r?.items[0] !== undefined) setCell(r.items[0].code);
  };

  if (pending.isLoading) return <Spinner />;
  const items = pending.data?.items ?? [];
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card title="Waiting for putaway">
        {items.length === 0 ? (
          <EmptyState>Nothing is waiting on the dock.</EmptyState>
        ) : (
          <ul className="flex flex-col gap-2">
            {items.map((i) => (
              <li key={`${i.sourceLocationId}${i.batchId}`}>
                <Button
                  variant={
                    picked?.batchId === i.batchId && picked.sourceLocationId === i.sourceLocationId
                      ? 'primary'
                      : 'secondary'
                  }
                  className="w-full justify-between"
                  onClick={() => void choose(i)}
                >
                  <span>
                    {i.skuCode} {i.batchCode !== '-' ? `(${i.batchCode})` : ''}
                  </span>
                  <span>
                    {i.qty} {i.kind === 'return' ? 'from return cell' : 'on dock'}
                  </span>
                </Button>
              </li>
            ))}
          </ul>
        )}
      </Card>
      <Card title="Place it">
        {picked === null ? (
          <EmptyState>Pick an item on the left.</EmptyState>
        ) : (
          <form
            className="flex flex-col gap-3"
            noValidate
            onSubmit={async (e) => {
              e.preventDefault();
              setError(null);
              try {
                await confirm.mutateAsync({
                  warehouseId,
                  data: {
                    sourceLocationId: picked.sourceLocationId,
                    skuId: picked.skuId,
                    batchId: picked.batchId,
                    qty: Number(qty),
                    cellCode: normalizeScan(cell),
                    idempotencyKey: newIdempotencyKey(),
                  },
                });
                playBeep('ok');
                toast('ok', `Placed in ${normalizeScan(cell)}`);
                setPicked(null);
                await qc.invalidateQueries();
              } catch (err) {
                playBeep('error');
                setError(
                  codeOf(err) === 'CELL_BLOCKED'
                    ? 'This cell is closed (stock count). Choose another.'
                    : messageOf(err),
                );
              }
            }}
          >
            {suggestions.length > 0 && (
              <p className="text-sm">
                Suggested: {suggestions.map((s) => `${s.code} (${s.reason})`).join(', ')}
              </p>
            )}
            {error !== null && <Banner kind="error">{error}</Banner>}
            <Field label="Scan the cell">
              {(f) => (
                <TextInput
                  id={f.id}
                  autoFocus
                  autoComplete="off"
                  value={cell}
                  onChange={(e) => setCell(e.target.value)}
                />
              )}
            </Field>
            <Field label="Quantity">
              {(f) => (
                <TextInput
                  id={f.id}
                  type="number"
                  min={1}
                  max={picked.qty}
                  value={qty}
                  onChange={(e) => setQty(e.target.value)}
                />
              )}
            </Field>
            <Button type="submit" disabled={confirm.isPending}>
              Confirm placement
            </Button>
          </form>
        )}
      </Card>
    </div>
  );
};
