'use client';

import { useQueryClient } from '@tanstack/react-query';
import { createSkuSchema } from '@ff/shared/schemas/setup';
import { useCatalogControllerCreate } from '@/shared/api/generated/shop/shop';
import { useApiForm } from '@/shared/lib/use-api-form';
import { Banner, Button, CheckboxInput, Field, TextInput, toast } from '@/shared/ui';

const FIELDS = [
  'code',
  'name',
  'barcode',
  'weightG',
  'lengthMm',
  'widthMm',
  'heightMm',
  'tracksExpiry',
] as const;
const num = { valueAsNumber: true } as const;

export const CreateSkuForm = () => {
  const qc = useQueryClient();
  const create = useCatalogControllerCreate();
  const { form, banner, submit } = useApiForm(createSkuSchema, {
    code: '',
    name: '',
    barcode: '',
    weightG: 100,
    lengthMm: 100,
    widthMm: 100,
    heightMm: 100,
    tracksExpiry: false,
  });
  const { register, formState, reset } = form;
  const e = formState.errors;
  return (
    <form
      className="grid gap-3 sm:grid-cols-2"
      noValidate
      onSubmit={submit(async (v) => {
        await create.mutateAsync({ data: v });
        toast('ok', `SKU ${v.code} created`);
        reset();
        await qc.invalidateQueries({ queryKey: ['/api/shop/v1/skus'] });
      }, FIELDS)}
    >
      {banner !== null && (
        <div className="sm:col-span-2">
          <Banner kind="error">{banner}</Banner>
        </div>
      )}
      <Field label="Code" error={e.code?.message}>
        {(f) => (
          <TextInput id={f.id} invalid={f.invalid} aria-describedby={f.describedBy} {...register('code')} />
        )}
      </Field>
      <Field label="Name" error={e.name?.message}>
        {(f) => (
          <TextInput id={f.id} invalid={f.invalid} aria-describedby={f.describedBy} {...register('name')} />
        )}
      </Field>
      <Field label="Barcode" error={e.barcode?.message}>
        {(f) => (
          <TextInput
            id={f.id}
            invalid={f.invalid}
            aria-describedby={f.describedBy}
            {...register('barcode')}
          />
        )}
      </Field>
      <Field label="Weight, g" error={e.weightG?.message}>
        {(f) => (
          <TextInput
            id={f.id}
            type="number"
            invalid={f.invalid}
            aria-describedby={f.describedBy}
            {...register('weightG', num)}
          />
        )}
      </Field>
      <Field label="Length, mm" error={e.lengthMm?.message}>
        {(f) => (
          <TextInput
            id={f.id}
            type="number"
            invalid={f.invalid}
            aria-describedby={f.describedBy}
            {...register('lengthMm', num)}
          />
        )}
      </Field>
      <Field label="Width, mm" error={e.widthMm?.message}>
        {(f) => (
          <TextInput
            id={f.id}
            type="number"
            invalid={f.invalid}
            aria-describedby={f.describedBy}
            {...register('widthMm', num)}
          />
        )}
      </Field>
      <Field label="Height, mm" error={e.heightMm?.message}>
        {(f) => (
          <TextInput
            id={f.id}
            type="number"
            invalid={f.invalid}
            aria-describedby={f.describedBy}
            {...register('heightMm', num)}
          />
        )}
      </Field>
      <Field label="Track batches and expiry" error={e.tracksExpiry?.message}>
        {(f) => <CheckboxInput id={f.id} {...register('tracksExpiry')} />}
      </Field>
      <div className="sm:col-span-2">
        <Button type="submit" disabled={formState.isSubmitting}>
          Create SKU
        </Button>
      </div>
    </form>
  );
};
