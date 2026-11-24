'use client';

import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useInboundControllerCreate } from '@/shared/api/generated/shop/shop';
import { messageOf } from '@/shared/lib/form-errors';
import { Banner, Button, Field, SelectInput, TextInput, toast } from '@/shared/ui';
import { parseLines } from '../model/parse-lines';

export const CreateInboundForm = ({
  warehouses,
}: {
  warehouses: readonly { id: string; code: string }[];
}) => {
  const qc = useQueryClient();
  const create = useInboundControllerCreate();
  const [reference, setReference] = useState('');
  const [warehouseId, setWarehouseId] = useState(warehouses[0]?.id ?? '');
  const [text, setText] = useState('');
  const [errors, setErrors] = useState<{ reference?: string; lines?: string; banner?: string }>({});
  return (
    <form
      className="flex flex-col gap-3"
      noValidate
      onSubmit={async (ev) => {
        ev.preventDefault();
        const parsed = parseLines(text);
        const next: typeof errors = {};
        if (reference.trim() === '') next.reference = 'Enter a reference';
        if (parsed.errors.length > 0 || parsed.lines.length === 0)
          next.lines = parsed.errors[0] ?? 'Add at least one line';
        setErrors(next);
        if (Object.keys(next).length > 0) return;
        try {
          await create.mutateAsync({
            data: { warehouseId, reference: reference.trim(), lines: [...parsed.lines] },
          });
          toast('ok', 'Inbound request created');
          setReference('');
          setText('');
          await qc.invalidateQueries({ queryKey: ['/api/shop/v1/inbound'] });
        } catch (e) {
          setErrors({ banner: messageOf(e) });
        }
      }}
    >
      {errors.banner !== undefined && <Banner kind="error">{errors.banner}</Banner>}
      <Field label="Warehouse">
        {(f) => (
          <SelectInput id={f.id} value={warehouseId} onChange={(e) => setWarehouseId(e.target.value)}>
            {warehouses.map((w) => (
              <option key={w.id} value={w.id}>
                {w.code}
              </option>
            ))}
          </SelectInput>
        )}
      </Field>
      <Field label="Reference" error={errors.reference}>
        {(f) => (
          <TextInput
            id={f.id}
            invalid={f.invalid}
            aria-describedby={f.describedBy}
            value={reference}
            onChange={(e) => setReference(e.target.value)}
          />
        )}
      </Field>
      <Field label="Lines" hint="One per line: SKU code, quantity" error={errors.lines}>
        {(f) => (
          <textarea
            id={f.id}
            aria-invalid={f.invalid}
            aria-describedby={f.describedBy}
            rows={5}
            className="rounded-md border border-[var(--line)] bg-[var(--card)] px-3 py-2 text-sm"
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
        )}
      </Field>
      <div>
        <Button type="submit" disabled={create.isPending}>
          Create inbound request
        </Button>
      </div>
    </form>
  );
};
