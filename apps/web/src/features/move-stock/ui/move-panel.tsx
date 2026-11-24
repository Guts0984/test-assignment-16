'use client';

import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import {
  useStockOpsControllerCellsStock,
  useStockOpsControllerMove,
  useStockOpsControllerTransfer,
} from '@/shared/api/generated/storekeeper/storekeeper';
import { codeOf, messageOf } from '@/shared/lib/form-errors';
import { newIdempotencyKey, normalizeScan } from '@/shared/lib/scan';
import { Banner, Button, Card, EmptyState, Field, SelectInput, Table, TextInput, toast } from '@/shared/ui';

/** Move stock between cells, or send it to another warehouse (it is "in transit" until received). */
export const MovePanel = ({
  warehouseId,
  warehouses,
}: {
  warehouseId: string;
  warehouses: readonly { id: string; code: string }[];
}) => {
  const qc = useQueryClient();
  const [sku, setSku] = useState('');
  const [query, setQuery] = useState('');
  const stock = useStockOpsControllerCellsStock(
    warehouseId,
    { sku: query },
    { query: { enabled: query !== '' } },
  );
  const move = useStockOpsControllerMove();
  const transfer = useStockOpsControllerTransfer();
  const [target, setTarget] = useState('');
  const [qty, setQty] = useState('1');
  const [dest, setDest] = useState(warehouses.find((w) => w.id !== warehouseId)?.id ?? '');
  const [error, setError] = useState<string | null>(null);
  const items = stock.data?.items ?? [];
  const [sel, setSel] = useState<string | null>(null);
  const row = items.find((i) => `${i.sourceLocationId}${i.batchId}` === sel);

  const run = async (kind: 'move' | 'transfer') => {
    if (row === undefined) return;
    setError(null);
    try {
      if (kind === 'move')
        await move.mutateAsync({
          warehouseId,
          data: {
            fromCellCode: row.kind,
            toCellCode: normalizeScan(target),
            skuId: row.skuId,
            batchId: row.batchId,
            qty: Number(qty),
            idempotencyKey: newIdempotencyKey(),
          },
        });
      else
        await transfer.mutateAsync({
          warehouseId,
          data: {
            toWarehouseId: dest,
            lines: [
              { cellId: row.sourceLocationId, skuId: row.skuId, batchId: row.batchId, qty: Number(qty) },
            ],
            idempotencyKey: newIdempotencyKey(),
          },
        });
      toast('ok', kind === 'move' ? 'Moved' : 'Transfer started');
      setSel(null);
      await qc.invalidateQueries();
    } catch (e) {
      setError(
        codeOf(e) === 'INSUFFICIENT_STOCK'
          ? 'Not enough free (unreserved) stock in that cell.'
          : messageOf(e),
      );
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <Card title="Find stock">
        <form
          className="flex items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            setQuery(normalizeScan(sku));
          }}
        >
          <Field label="Barcode or SKU code">
            {(f) => (
              <TextInput id={f.id} value={sku} onChange={(e) => setSku(e.target.value)} autoComplete="off" />
            )}
          </Field>
          <Button type="submit">Search</Button>
        </form>
        {query !== '' &&
          (items.length === 0 ? (
            <EmptyState>No stock found.</EmptyState>
          ) : (
            <Table head={['Cell', 'SKU', 'Batch', 'Free', '']}>
              {items.map((i) => (
                <tr key={`${i.sourceLocationId}${i.batchId}`}>
                  <td>{i.kind}</td>
                  <td>{i.skuCode}</td>
                  <td>{i.batchCode}</td>
                  <td>{i.qty}</td>
                  <td>
                    <Button
                      variant="secondary"
                      onClick={() => {
                        setSel(`${i.sourceLocationId}${i.batchId}`);
                        setQty('1');
                      }}
                    >
                      Select
                    </Button>
                  </td>
                </tr>
              ))}
            </Table>
          ))}
      </Card>
      {row !== undefined && (
        <Card title={`${row.skuCode} from ${row.kind}`}>
          {error !== null && <Banner kind="error">{error}</Banner>}
          <div className="mt-3 grid gap-3 sm:grid-cols-3">
            <Field label="Quantity">
              {(f) => (
                <TextInput
                  id={f.id}
                  type="number"
                  min={1}
                  max={row.qty}
                  value={qty}
                  onChange={(e) => setQty(e.target.value)}
                />
              )}
            </Field>
            <Field label="To cell">
              {(f) => (
                <TextInput
                  id={f.id}
                  value={target}
                  onChange={(e) => setTarget(e.target.value)}
                  autoComplete="off"
                />
              )}
            </Field>
            <div className="flex items-end">
              <Button disabled={move.isPending || target === ''} onClick={() => void run('move')}>
                Move
              </Button>
            </div>
            <Field label="Other warehouse">
              {(f) => (
                <SelectInput id={f.id} value={dest} onChange={(e) => setDest(e.target.value)}>
                  {warehouses
                    .filter((w) => w.id !== warehouseId)
                    .map((w) => (
                      <option key={w.id} value={w.id}>
                        {w.code}
                      </option>
                    ))}
                </SelectInput>
              )}
            </Field>
            <div className="flex items-end">
              <Button
                variant="secondary"
                disabled={transfer.isPending || dest === ''}
                onClick={() => void run('transfer')}
              >
                Send to warehouse
              </Button>
            </div>
          </div>
        </Card>
      )}
    </div>
  );
};
