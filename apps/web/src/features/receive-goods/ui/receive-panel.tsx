'use client';

import { useQueryClient } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import {
  useStockOpsControllerAddLine,
  useStockOpsControllerClose,
  useStockOpsControllerCreateReceipt,
} from '@/shared/api/generated/storekeeper/storekeeper';
import { codeOf, messageOf } from '@/shared/lib/form-errors';
import { newIdempotencyKey } from '@/shared/lib/scan';
import { playBeep } from '@/shared/lib/sound';
import { Banner, Button, Card, Field, SelectInput, Table, TextInput, toast } from '@/shared/ui';

type Line = { barcode: string; qty: number; batch?: string; expires?: string };

/** Receiving: open a receipt for a shop, scan items with quantity (and batch + expiry when tracked), close. */
export const ReceivePanel = ({
  warehouseId,
  shops,
}: {
  warehouseId: string;
  shops: readonly { id: string; code: string; name: string }[];
}) => {
  const qc = useQueryClient();
  const create = useStockOpsControllerCreateReceipt();
  const add = useStockOpsControllerAddLine();
  const close = useStockOpsControllerClose();
  const [shopId, setShopId] = useState(shops[0]?.id ?? '');
  const [receipt, setReceipt] = useState<string | null>(null);
  const [lines, setLines] = useState<Line[]>([]);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [needsBatch, setNeedsBatch] = useState(false);
  const [summary, setSummary] = useState<
    { expectedQty: number; receivedQty: number; skuId: string }[] | null
  >(null);
  const barcode = useRef<HTMLInputElement>(null);
  const [form, setForm] = useState({ barcode: '', qty: '1', batch: '', expires: '' });

  if (receipt === null) {
    return (
      <Card title="New receipt">
        <div className="flex flex-col gap-3 sm:max-w-sm">
          <Field label="Shop">
            {(f) => (
              <SelectInput id={f.id} value={shopId} onChange={(e) => setShopId(e.target.value)}>
                {shops.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.code} - {s.name}
                  </option>
                ))}
              </SelectInput>
            )}
          </Field>
          <Button
            disabled={shopId === '' || create.isPending}
            onClick={async () => {
              try {
                const r = await create.mutateAsync({ warehouseId, data: { shopId } });
                setReceipt(r.id);
                setLines([]);
                setSummary(null);
              } catch (e) {
                toast('error', messageOf(e));
              }
            }}
          >
            Start receiving
          </Button>
        </div>
      </Card>
    );
  }
  const submit = async () => {
    const e: Record<string, string> = {};
    if (form.barcode.trim() === '') e.barcode = 'Scan or enter a barcode';
    const qty = Number(form.qty);
    if (!Number.isInteger(qty) || qty < 1) e.qty = 'Enter a whole number, at least 1';
    if (needsBatch && form.batch.trim() === '') e.batch = 'Batch is required for this item';
    if (needsBatch && form.expires === '') e.expires = 'Expiry date is required for this item';
    setErrors(e);
    if (Object.keys(e).length > 0) return;
    try {
      await add.mutateAsync({
        warehouseId,
        id: receipt,
        data: {
          barcode: form.barcode.trim(),
          qty,
          ...(form.batch !== '' ? { batchCode: form.batch.trim(), expiresOn: form.expires } : {}),
          idempotencyKey: newIdempotencyKey(),
        },
      });
      playBeep('ok');
      setLines((l) => [
        ...l,
        {
          barcode: form.barcode.trim(),
          qty,
          ...(form.batch !== '' ? { batch: form.batch, expires: form.expires } : {}),
        },
      ]);
      setForm({ barcode: '', qty: '1', batch: '', expires: '' });
      setNeedsBatch(false);
      barcode.current?.focus();
    } catch (err) {
      playBeep('error');
      const code = codeOf(err);
      if (code === 'BATCH_REQUIRED') setNeedsBatch(true);
      setErrors({
        [code === 'EXPIRY_IN_PAST' ? 'expires' : code === 'UNKNOWN_SKU' ? 'barcode' : 'banner']:
          messageOf(err),
      });
    }
  };
  return (
    <div className="flex flex-col gap-4">
      <Card title="Receiving">
        {errors.banner !== undefined && <Banner kind="error">{errors.banner}</Banner>}
        <form
          className="mt-3 grid gap-3 sm:grid-cols-4"
          noValidate
          onSubmit={(ev) => {
            ev.preventDefault();
            void submit();
          }}
        >
          <Field label="Barcode" error={errors.barcode}>
            {(f) => (
              <TextInput
                id={f.id}
                ref={barcode}
                autoFocus
                autoComplete="off"
                invalid={f.invalid}
                aria-describedby={f.describedBy}
                value={form.barcode}
                onChange={(e) => setForm({ ...form, barcode: e.target.value })}
              />
            )}
          </Field>
          <Field label="Quantity" error={errors.qty}>
            {(f) => (
              <TextInput
                id={f.id}
                type="number"
                min={1}
                invalid={f.invalid}
                aria-describedby={f.describedBy}
                value={form.qty}
                onChange={(e) => setForm({ ...form, qty: e.target.value })}
              />
            )}
          </Field>
          {needsBatch && (
            <>
              <Field label="Batch" error={errors.batch}>
                {(f) => (
                  <TextInput
                    id={f.id}
                    invalid={f.invalid}
                    aria-describedby={f.describedBy}
                    value={form.batch}
                    onChange={(e) => setForm({ ...form, batch: e.target.value })}
                  />
                )}
              </Field>
              <Field label="Expiry date" error={errors.expires}>
                {(f) => (
                  <TextInput
                    id={f.id}
                    type="date"
                    invalid={f.invalid}
                    aria-describedby={f.describedBy}
                    value={form.expires}
                    onChange={(e) => setForm({ ...form, expires: e.target.value })}
                  />
                )}
              </Field>
            </>
          )}
          <div className="sm:col-span-4">
            <Button type="submit" disabled={add.isPending}>
              Add to receipt
            </Button>
          </div>
        </form>
      </Card>
      <Card title={`Scanned (${lines.length})`}>
        <Table head={['Barcode', 'Qty', 'Batch', 'Expires']}>
          {lines.map((l, i) => (
            <tr key={i}>
              <td>{l.barcode}</td>
              <td>{l.qty}</td>
              <td>{l.batch ?? '-'}</td>
              <td>{l.expires ?? '-'}</td>
            </tr>
          ))}
        </Table>
        <div className="mt-3">
          <Button
            variant="secondary"
            onClick={async () => {
              try {
                const r = await close.mutateAsync({ warehouseId, id: receipt });
                setSummary([...r.discrepancies]);
                setReceipt(null);
                await qc.invalidateQueries();
                toast(
                  'ok',
                  r.discrepancies.length === 0
                    ? 'Receipt closed'
                    : `Receipt closed with ${r.discrepancies.length} discrepancies`,
                );
              } catch (e) {
                toast('error', messageOf(e));
              }
            }}
          >
            Close receipt
          </Button>
        </div>
      </Card>
      {summary !== null && summary.length > 0 && (
        <Banner>
          Discrepancies recorded:{' '}
          {summary
            .map((d) => `${d.skuId.slice(0, 8)} expected ${d.expectedQty}, received ${d.receivedQty}`)
            .join('; ')}
        </Banner>
      )}
    </div>
  );
};
