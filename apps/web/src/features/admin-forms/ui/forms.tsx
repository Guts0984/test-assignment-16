'use client';

import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { createShopSchema, createStaffSchema, createWarehouseSchema } from '@ff/shared/schemas/setup';
import {
  useAdminControllerCreateCells,
  useAdminControllerCreateShop,
  useAdminControllerCreateStaff,
  useAdminControllerCreateWarehouse,
  useAdminControllerCreateZone,
  useAdminControllerCreateKey,
  useAdminControllerRevokeKey,
} from '@/shared/api/generated/admin/admin';
import { useJobsAdminControllerRerun } from '@/shared/api/generated/admin/admin';
import { messageOf } from '@/shared/lib/form-errors';
import { useApiForm } from '@/shared/lib/use-api-form';
import { Banner, Button, Field, SelectInput, TextInput, toast } from '@/shared/ui';

const num = { valueAsNumber: true } as const;
const useRefresh = () => {
  const qc = useQueryClient();
  return () => qc.invalidateQueries();
};

export const CreateWarehouseForm = () => {
  const create = useAdminControllerCreateWarehouse();
  const refresh = useRefresh();
  const { form, banner, submit } = useApiForm(createWarehouseSchema, {
    code: '',
    name: '',
    country: 'PL',
    timeZone: 'Europe/Warsaw',
    cutoffLocal: '17:00',
    workingDays: [1, 2, 3, 4, 5],
  });
  const { register, formState, reset } = form;
  const e = formState.errors;
  return (
    <form
      className="grid gap-3 sm:grid-cols-3"
      noValidate
      onSubmit={submit(
        async (v) => {
          await create.mutateAsync({ data: v });
          toast('ok', `Warehouse ${v.code} created`);
          reset();
          await refresh();
        },
        ['code', 'name', 'country', 'timeZone', 'cutoffLocal', 'workingDays'],
      )}
    >
      {banner !== null && (
        <div className="sm:col-span-3">
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
      <Field label="Country (2 letters)" error={e.country?.message}>
        {(f) => (
          <TextInput
            id={f.id}
            invalid={f.invalid}
            aria-describedby={f.describedBy}
            {...register('country')}
          />
        )}
      </Field>
      <Field label="Time zone" error={e.timeZone?.message}>
        {(f) => (
          <TextInput
            id={f.id}
            invalid={f.invalid}
            aria-describedby={f.describedBy}
            {...register('timeZone')}
          />
        )}
      </Field>
      <Field label="Carrier cutoff (local, HH:MM)" error={e.cutoffLocal?.message}>
        {(f) => (
          <TextInput
            id={f.id}
            invalid={f.invalid}
            aria-describedby={f.describedBy}
            {...register('cutoffLocal')}
          />
        )}
      </Field>
      <div className="flex items-end">
        <Button type="submit" disabled={formState.isSubmitting}>
          Create warehouse
        </Button>
      </div>
    </form>
  );
};

/** Zones and cells in bulk: a code prefix and a count generate the cells with walk order. */
export const AddCellsForm = ({ warehouses }: { warehouses: readonly { id: string; code: string }[] }) => {
  const zone = useAdminControllerCreateZone();
  const cells = useAdminControllerCreateCells();
  const refresh = useRefresh();
  const [s, setS] = useState({
    warehouseId: warehouses[0]?.id ?? '',
    zone: 'A',
    count: '10',
    volume: '10000000',
    weight: '5000000',
  });
  const [err, setErr] = useState<Record<string, string>>({});
  return (
    <form
      className="grid gap-3 sm:grid-cols-3"
      noValidate
      onSubmit={async (ev) => {
        ev.preventDefault();
        const next: Record<string, string> = {};
        const count = Number(s.count);
        if (!/^[A-Z0-9][A-Z0-9_-]{0,31}$/.test(s.zone)) next.zone = 'Upper-case letters, digits, _ or -';
        if (!Number.isInteger(count) || count < 1 || count > 500) next.count = 'Between 1 and 500';
        if (!(Number(s.volume) > 0)) next.volume = 'Must be greater than 0';
        if (!(Number(s.weight) > 0)) next.weight = 'Must be greater than 0';
        setErr(next);
        if (Object.keys(next).length > 0) return;
        try {
          const z = await zone.mutateAsync({
            id: s.warehouseId,
            data: { code: s.zone, name: `Zone ${s.zone}` },
          });
          await cells.mutateAsync({
            zoneId: z.id,
            data: {
              cells: Array.from({ length: count }, (_, i) => ({
                code: `${s.zone}-${String(i + 1).padStart(3, '0')}`,
                walkOrder: i + 1,
                capacityVolumeCm3: Number(s.volume),
                capacityWeightG: Number(s.weight),
              })),
            },
          });
          toast('ok', `Zone ${s.zone} with ${count} cells created`);
          await refresh();
        } catch (e) {
          setErr({ banner: messageOf(e) });
        }
      }}
    >
      {err.banner !== undefined && (
        <div className="sm:col-span-3">
          <Banner kind="error">{err.banner}</Banner>
        </div>
      )}
      <Field label="Warehouse">
        {(f) => (
          <SelectInput
            id={f.id}
            value={s.warehouseId}
            onChange={(e) => setS({ ...s, warehouseId: e.target.value })}
          >
            {warehouses.map((w) => (
              <option key={w.id} value={w.id}>
                {w.code}
              </option>
            ))}
          </SelectInput>
        )}
      </Field>
      <Field label="Zone code" error={err.zone}>
        {(f) => (
          <TextInput
            id={f.id}
            invalid={f.invalid}
            aria-describedby={f.describedBy}
            value={s.zone}
            onChange={(e) => setS({ ...s, zone: e.target.value })}
          />
        )}
      </Field>
      <Field label="Number of cells" error={err.count}>
        {(f) => (
          <TextInput
            id={f.id}
            type="number"
            invalid={f.invalid}
            aria-describedby={f.describedBy}
            value={s.count}
            onChange={(e) => setS({ ...s, count: e.target.value })}
          />
        )}
      </Field>
      <Field label="Capacity, cm3" error={err.volume}>
        {(f) => (
          <TextInput
            id={f.id}
            type="number"
            invalid={f.invalid}
            aria-describedby={f.describedBy}
            value={s.volume}
            onChange={(e) => setS({ ...s, volume: e.target.value })}
          />
        )}
      </Field>
      <Field label="Capacity, g" error={err.weight}>
        {(f) => (
          <TextInput
            id={f.id}
            type="number"
            invalid={f.invalid}
            aria-describedby={f.describedBy}
            value={s.weight}
            onChange={(e) => setS({ ...s, weight: e.target.value })}
          />
        )}
      </Field>
      <div className="flex items-end">
        <Button type="submit" disabled={zone.isPending || cells.isPending || s.warehouseId === ''}>
          Add zone and cells
        </Button>
      </div>
    </form>
  );
};

export const CreateShopForm = () => {
  const create = useAdminControllerCreateShop();
  const refresh = useRefresh();
  const [secrets, setSecrets] = useState<{ apiKey: string; webhookSecret: string } | null>(null);
  const { form, banner, submit } = useApiForm(createShopSchema, {
    code: '',
    name: '',
    webhookUrl: 'http://shop-stub:4000/webhooks/NEW',
    minShelfLifeDays: 0,
  });
  const { register, formState, reset } = form;
  const e = formState.errors;
  return (
    <div className="flex flex-col gap-3">
      <form
        className="grid gap-3 sm:grid-cols-2"
        noValidate
        onSubmit={submit(
          async (v) => {
            const r = await create.mutateAsync({ data: v });
            setSecrets({ apiKey: r.apiKey, webhookSecret: r.webhookSecret });
            reset();
            await refresh();
          },
          ['code', 'name', 'webhookUrl', 'minShelfLifeDays'],
        )}
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
        <Field label="Webhook URL" error={e.webhookUrl?.message}>
          {(f) => (
            <TextInput
              id={f.id}
              invalid={f.invalid}
              aria-describedby={f.describedBy}
              {...register('webhookUrl')}
            />
          )}
        </Field>
        <Field label="Minimum remaining shelf life at shipment, days" error={e.minShelfLifeDays?.message}>
          {(f) => (
            <TextInput
              id={f.id}
              type="number"
              invalid={f.invalid}
              aria-describedby={f.describedBy}
              {...register('minShelfLifeDays', num)}
            />
          )}
        </Field>
        <div className="sm:col-span-2">
          <Button type="submit" disabled={formState.isSubmitting}>
            Connect shop
          </Button>
        </div>
      </form>
      {secrets !== null && (
        <Banner kind="ok">
          Shown once. API key: <code data-testid="new-api-key">{secrets.apiKey}</code> - webhook secret:{' '}
          <code>{secrets.webhookSecret}</code>
        </Banner>
      )}
    </div>
  );
};

export const ShopKeyActions = ({
  shopId,
  keys,
}: {
  shopId: string;
  keys: readonly { id: string; prefix: string; revokedAt: string | null }[];
}) => {
  const create = useAdminControllerCreateKey();
  const revoke = useAdminControllerRevokeKey();
  const refresh = useRefresh();
  const [shown, setShown] = useState<string | null>(null);
  return (
    <div className="flex flex-col gap-2">
      <ul className="text-sm">
        {keys.map((k) => (
          <li key={k.id} className="flex items-center gap-2">
            <code>fk_{k.prefix}_...</code>
            {k.revokedAt === null ? (
              <Button
                variant="danger"
                onClick={async () => {
                  await revoke
                    .mutateAsync({ id: shopId, keyId: k.id })
                    .catch((e) => toast('error', messageOf(e)));
                  await refresh();
                }}
              >
                Revoke
              </Button>
            ) : (
              <span className="text-[var(--muted)]">revoked</span>
            )}
          </li>
        ))}
      </ul>
      <Button
        variant="secondary"
        onClick={async () => {
          const r = await create.mutateAsync({ id: shopId }).catch(() => null);
          if (r !== null) setShown(r.apiKey);
          await refresh();
        }}
      >
        New API key
      </Button>
      {shown !== null && (
        <Banner kind="ok">
          Shown once: <code>{shown}</code>
        </Banner>
      )}
    </div>
  );
};

const ROLES = ['shift_lead', 'storekeeper', 'picker', 'packer', 'admin'] as const;

export const CreateStaffForm = ({ warehouses }: { warehouses: readonly { id: string; code: string }[] }) => {
  const create = useAdminControllerCreateStaff();
  const refresh = useRefresh();
  const { form, banner, submit } = useApiForm(createStaffSchema, {
    email: '',
    name: '',
    password: '',
    roles: [],
  });
  const [role, setRole] = useState<(typeof ROLES)[number]>('picker');
  const [wh, setWh] = useState(warehouses[0]?.id ?? '');
  const { register, formState, reset, watch, setValue } = form;
  const e = formState.errors;
  type RoleRow = { role: (typeof ROLES)[number]; warehouseId: string | null };
  const roles = (watch('roles') ?? []) as RoleRow[];
  return (
    <form
      className="grid gap-3 sm:grid-cols-2"
      noValidate
      onSubmit={submit(
        async (v) => {
          await create.mutateAsync({ data: v });
          toast('ok', `Account ${v.email} created`);
          reset();
          await refresh();
        },
        ['email', 'name', 'password', 'roles'],
      )}
    >
      {banner !== null && (
        <div className="sm:col-span-2">
          <Banner kind="error">{banner}</Banner>
        </div>
      )}
      <Field label="Email" error={e.email?.message}>
        {(f) => (
          <TextInput
            id={f.id}
            type="email"
            invalid={f.invalid}
            aria-describedby={f.describedBy}
            {...register('email')}
          />
        )}
      </Field>
      <Field label="Name" error={e.name?.message}>
        {(f) => (
          <TextInput id={f.id} invalid={f.invalid} aria-describedby={f.describedBy} {...register('name')} />
        )}
      </Field>
      <Field label="Password (min 8)" error={e.password?.message}>
        {(f) => (
          <TextInput
            id={f.id}
            type="password"
            autoComplete="new-password"
            invalid={f.invalid}
            aria-describedby={f.describedBy}
            {...register('password')}
          />
        )}
      </Field>
      <div className="flex flex-col gap-2">
        <span className="text-sm font-medium">Roles</span>
        <div className="flex flex-wrap gap-2">
          <SelectInput
            aria-label="Role"
            value={role}
            onChange={(ev) => setRole(ev.target.value as (typeof ROLES)[number])}
          >
            {ROLES.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </SelectInput>
          {role !== 'admin' && (
            <SelectInput aria-label="Warehouse" value={wh} onChange={(ev) => setWh(ev.target.value)}>
              {warehouses.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.code}
                </option>
              ))}
            </SelectInput>
          )}
          <Button
            variant="secondary"
            onClick={() =>
              setValue('roles', [...roles, { role, warehouseId: role === 'admin' ? null : wh }] as never)
            }
          >
            Add role
          </Button>
        </div>
        <ul className="text-sm">
          {roles.map((r, i) => (
            <li key={i}>
              {r.role}
              {r.warehouseId === null
                ? ' (all)'
                : ` @ ${warehouses.find((w) => w.id === r.warehouseId)?.code ?? ''}`}
            </li>
          ))}
        </ul>
        {e.roles?.message !== undefined && (
          <span role="alert" className="text-xs text-[var(--danger)]">
            {e.roles.message}
          </span>
        )}
      </div>
      <div className="sm:col-span-2">
        <Button type="submit" disabled={formState.isSubmitting}>
          Create account
        </Button>
      </div>
    </form>
  );
};

export const RerunJobButton = ({ jobId }: { jobId: string }) => {
  const rerun = useJobsAdminControllerRerun();
  const refresh = useRefresh();
  return (
    <Button
      variant="secondary"
      disabled={rerun.isPending}
      onClick={async () => {
        try {
          await rerun.mutateAsync({ id: jobId });
          toast('ok', 'Job queued again');
        } catch (e) {
          toast('error', messageOf(e));
        }
        await refresh();
      }}
    >
      Run again
    </Button>
  );
};
