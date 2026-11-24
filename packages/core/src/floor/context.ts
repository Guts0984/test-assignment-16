// Dependencies and settings shared by floor use-cases, plus warehouse calendar loading.
import { type Db, type Tx } from '@ff/db/client';
import { type IsoWeekday, type WarehouseCalendar } from '@ff/shared/time/calendar';
import { type Clock } from '../clock';
import { type Effects } from '../effects';
import { type Ctx } from './ledger-ops';

export type FloorSettings = {
  readonly webhookCoalesceMs: number;
  readonly partialReserveTtlMin: number;
  readonly waveReadyThreshold: number;
  readonly waveMaxOrders: number;
  readonly waveIntervalMin: number;
};

export type FloorDeps = { readonly db: Db; readonly clock: Clock; readonly settings: FloorSettings };

export const DEFAULT_SETTINGS: FloorSettings = {
  webhookCoalesceMs: 5000,
  partialReserveTtlMin: 2880,
  waveReadyThreshold: 50,
  waveMaxOrders: 200,
  waveIntervalMin: 15,
};

export type Actor = { readonly type: 'system' | 'staff' | 'shop'; readonly id: string | null };
export const SYSTEM: Actor = { type: 'system', id: null };

export const ctxOf = (
  tx: Tx,
  fx: Effects,
  d: FloorDeps,
  actor: Actor,
  docType: string,
  docId: string,
  now: Date,
): Ctx => ({
  tx,
  fx,
  now,
  actorType: actor.type,
  actorId: actor.id,
  docType,
  docId,
  windowMs: d.settings.webhookCoalesceMs,
});

export type WarehouseRow = WarehouseCalendar & {
  readonly id: string;
  readonly code: string;
  readonly country: string;
  readonly lat: number | null;
  readonly lon: number | null;
};

export const loadWarehouses = async (tx: Tx | Db): Promise<readonly WarehouseRow[]> =>
  (
    await tx.$queryRaw<
      {
        id: string;
        code: string;
        country: string;
        lat: number | null;
        lon: number | null;
        time_zone: string;
        cutoff_local: string;
        working_days: number[];
        holidays: string[];
      }[]
    >`SELECT id, code, country, lat, lon, time_zone, cutoff_local, working_days, holidays FROM warehouses ORDER BY id`
  ).map((w) => ({
    id: w.id,
    code: w.code,
    country: w.country,
    lat: w.lat,
    lon: w.lon,
    timeZone: w.time_zone,
    cutoffLocal: w.cutoff_local,
    workingDays: w.working_days as IsoWeekday[],
    holidays: w.holidays,
  }));

export const loadWarehouse = async (tx: Tx | Db, id: string): Promise<WarehouseRow | null> =>
  (await loadWarehouses(tx)).find((w) => w.id === id) ?? null;
