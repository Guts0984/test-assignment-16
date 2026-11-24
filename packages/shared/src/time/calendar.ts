// Warehouse calendar: cutoff and shipping day in the warehouse's own time zone (DST-aware).
// Rule (ASSIGNMENT "Cutoff"): packed strictly before the local cutoff ships today, otherwise on the
// next working day. Exactly at the cutoff counts as after it (plan.md A-15).
import { DateTime, IANAZone } from 'luxon';

/** ISO weekday: 1 = Monday … 7 = Sunday. */
export type IsoWeekday = 1 | 2 | 3 | 4 | 5 | 6 | 7;

export type WarehouseCalendar = {
  readonly timeZone: string;
  /** Local wall-clock cutoff, "HH:MM". */
  readonly cutoffLocal: string;
  readonly workingDays: readonly IsoWeekday[];
  /** Local dates "YYYY-MM-DD" with no shipping. */
  readonly holidays: readonly string[];
};

const CUTOFF_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;
const MAX_SCAN_DAYS = 800;

export const isValidTimeZone = (tz: string): boolean => IANAZone.isValidZone(tz);
export const isValidCutoff = (s: string): boolean => CUTOFF_RE.test(s);

const parseCutoff = (s: string): { readonly hour: number; readonly minute: number } => {
  const m = CUTOFF_RE.exec(s);
  if (m === null) throw new Error(`invalid cutoff "${s}"`);
  return { hour: Number(m[1]), minute: Number(m[2]) };
};

const localDay = (isoDate: string, tz: string): DateTime => {
  const d = DateTime.fromISO(isoDate, { zone: tz });
  if (!d.isValid) throw new Error(`invalid date "${isoDate}"`);
  return d.startOf('day');
};

const toIsoDate = (d: DateTime): string => {
  const s = d.toISODate();
  if (s === null) throw new Error('invalid DateTime');
  return s;
};

export const isWorkingDay = (isoDate: string, cal: WarehouseCalendar): boolean => {
  const d = localDay(isoDate, cal.timeZone);
  return cal.workingDays.includes(d.weekday as IsoWeekday) && !cal.holidays.includes(isoDate);
};

/** The first working day strictly after `isoDate`. */
export const nextWorkingDay = (isoDate: string, cal: WarehouseCalendar): string => {
  const start = localDay(isoDate, cal.timeZone);
  for (let i = 1; i <= MAX_SCAN_DAYS; i += 1) {
    const candidate = toIsoDate(start.plus({ days: i }));
    if (isWorkingDay(candidate, cal)) return candidate;
  }
  throw new Error('calendar has no working day within the scan window');
};

/**
 * The cutoff instant of a local date. If the cutoff falls into a skipped DST hour, Luxon moves it
 * forward by the gap (02:30 becomes 03:30); in an ambiguous hour the earlier offset is used.
 */
export const cutoffInstant = (isoDate: string, cal: WarehouseCalendar): Date => {
  const { hour, minute } = parseCutoff(cal.cutoffLocal);
  return localDay(isoDate, cal.timeZone).set({ hour, minute, second: 0, millisecond: 0 }).toJSDate();
};

export const localDateOf = (at: Date, tz: string): string =>
  toIsoDate(DateTime.fromJSDate(at, { zone: tz }));

/** Shipping day (local date) for an order packed at `packedAt`. */
export const shipDayFor = (packedAt: Date, cal: WarehouseCalendar): string => {
  const today = localDateOf(packedAt, cal.timeZone);
  const beforeCutoff = packedAt.getTime() < cutoffInstant(today, cal).getTime();
  return isWorkingDay(today, cal) && beforeCutoff ? today : nextWorkingDay(today, cal);
};

/** The next cutoff an order handled at `now` can still make, and the time left until it. */
export const nextCutoff = (
  now: Date,
  cal: WarehouseCalendar,
): { readonly shipDay: string; readonly cutoffAt: Date; readonly msLeft: number } => {
  const shipDay = shipDayFor(now, cal);
  const cutoffAt = cutoffInstant(shipDay, cal);
  return { shipDay, cutoffAt, msLeft: cutoffAt.getTime() - now.getTime() };
};

/** Whole calendar days from `fromIsoDate` to `toIsoDate` (negative when `to` is earlier). */
export const daysBetween = (fromIsoDate: string, toIsoDate: string): number =>
  Math.round(
    DateTime.fromISO(toIsoDate, { zone: 'UTC' }).diff(DateTime.fromISO(fromIsoDate, { zone: 'UTC' }), 'days').days,
  );

/** Local wall-clock instant ("HH:MM" on a local date) as UTC. */
export const localTimeInstant = (isoDate: string, hhmm: string, tz: string): Date => {
  const { hour, minute } = parseCutoff(hhmm);
  return localDay(isoDate, tz).set({ hour, minute, second: 0, millisecond: 0 }).toJSDate();
};

export const addDays = (isoDate: string, days: number): string =>
  toIsoDate(DateTime.fromISO(isoDate, { zone: 'UTC' }).plus({ days }));
