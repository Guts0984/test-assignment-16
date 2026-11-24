import { describe, expect, it } from 'vitest';
import {
  cutoffInstant,
  daysBetween,
  isValidCutoff,
  isValidTimeZone,
  nextCutoff,
  nextWorkingDay,
  shipDayFor,
  type WarehouseCalendar,
} from './calendar';

const warsaw: WarehouseCalendar = {
  timeZone: 'Europe/Warsaw',
  cutoffLocal: '17:00',
  workingDays: [1, 2, 3, 4, 5],
  holidays: [],
};
const kyiv: WarehouseCalendar = { ...warsaw, timeZone: 'Europe/Kyiv' };

const at = (iso: string): Date => new Date(iso);

describe('shipDayFor: cutoff boundary', () => {
  // 2026-11-24 is a Tuesday; Warsaw is UTC+1 in winter, so 17:00 local = 16:00Z.
  it('16:59:59.999 local ships today', () => {
    expect(shipDayFor(at('2026-11-24T15:59:59.999Z'), warsaw)).toBe('2026-11-24');
  });
  it('exactly 17:00:00.000 local ships next working day', () => {
    expect(shipDayFor(at('2026-11-24T16:00:00.000Z'), warsaw)).toBe('2026-11-25');
  });
  it('17:00:00.001 local ships next working day', () => {
    expect(shipDayFor(at('2026-11-24T16:00:00.001Z'), warsaw)).toBe('2026-11-25');
  });
});

describe('shipDayFor: acceptance #10, Friday 17:01 in Warsaw', () => {
  it('ships on Monday', () => {
    // Friday 2026-11-27 17:01 CET = 16:01Z
    expect(shipDayFor(at('2026-11-27T16:01:00Z'), warsaw)).toBe('2026-11-30');
  });
  it('ships on Tuesday when Monday is a holiday', () => {
    expect(shipDayFor(at('2026-11-27T16:01:00Z'), { ...warsaw, holidays: ['2026-11-30'] })).toBe('2026-12-01');
  });
  it('packing on Saturday ships Monday even before the cutoff time', () => {
    expect(shipDayFor(at('2026-11-28T09:00:00Z'), warsaw)).toBe('2026-11-30');
  });
  it('honours custom working days (Mon-Sat warehouse ships Saturday)', () => {
    expect(shipDayFor(at('2026-11-27T16:01:00Z'), { ...warsaw, workingDays: [1, 2, 3, 4, 5, 6] })).toBe(
      '2026-11-28',
    );
  });
});

describe('DST transitions', () => {
  // Spring forward: last Sunday of March 2026 is 2026-03-29.
  it('Warsaw: Friday before spring DST, 17:01 CET ships Monday; Monday cutoff is 15:00Z (CEST)', () => {
    expect(shipDayFor(at('2026-03-27T16:01:00Z'), warsaw)).toBe('2026-03-30');
    expect(cutoffInstant('2026-03-27', warsaw).toISOString()).toBe('2026-03-27T16:00:00.000Z');
    expect(cutoffInstant('2026-03-30', warsaw).toISOString()).toBe('2026-03-30T15:00:00.000Z');
  });
  it('Warsaw: 16:30Z on Monday after spring DST is 18:30 CEST, so after cutoff', () => {
    expect(shipDayFor(at('2026-03-30T15:30:00Z'), warsaw)).toBe('2026-03-31');
    expect(shipDayFor(at('2026-03-30T14:59:59.999Z'), warsaw)).toBe('2026-03-30');
  });
  it('Kyiv: spring DST moves the cutoff from 15:00Z to 14:00Z', () => {
    expect(cutoffInstant('2026-03-27', kyiv).toISOString()).toBe('2026-03-27T15:00:00.000Z');
    expect(cutoffInstant('2026-03-30', kyiv).toISOString()).toBe('2026-03-30T14:00:00.000Z');
  });
  // Fall back: last Sunday of October 2026 is 2026-10-25.
  it('Warsaw: autumn DST moves the cutoff from 15:00Z to 16:00Z', () => {
    expect(cutoffInstant('2026-10-23', warsaw).toISOString()).toBe('2026-10-23T15:00:00.000Z');
    expect(cutoffInstant('2026-10-26', warsaw).toISOString()).toBe('2026-10-26T16:00:00.000Z');
    // 15:30Z on Monday 26 Oct is 16:30 CET: before cutoff (it would have been after cutoff in summer time).
    expect(shipDayFor(at('2026-10-26T15:30:00Z'), warsaw)).toBe('2026-10-26');
  });
  it('Kyiv: autumn DST, 14:30Z Monday is 16:30 EET, before cutoff', () => {
    expect(shipDayFor(at('2026-10-26T14:30:00Z'), kyiv)).toBe('2026-10-26');
    expect(shipDayFor(at('2026-10-26T15:00:00Z'), kyiv)).toBe('2026-10-27');
  });
  it('a cutoff inside the skipped hour is moved forward by the gap', () => {
    const night: WarehouseCalendar = { ...warsaw, cutoffLocal: '02:30', workingDays: [1, 2, 3, 4, 5, 6, 7] };
    // 2026-03-29 02:30 does not exist in Warsaw; Luxon gives 03:30 CEST = 01:30Z.
    expect(cutoffInstant('2026-03-29', night).toISOString()).toBe('2026-03-29T01:30:00.000Z');
  });
  it('a cutoff inside the repeated hour uses the earlier offset', () => {
    const night: WarehouseCalendar = { ...warsaw, cutoffLocal: '02:30', workingDays: [1, 2, 3, 4, 5, 6, 7] };
    expect(cutoffInstant('2026-10-25', night).toISOString()).toBe('2026-10-25T00:30:00.000Z');
  });
  it('a pack during the DST night itself is on the local Sunday', () => {
    expect(shipDayFor(at('2026-03-29T01:30:00Z'), warsaw)).toBe('2026-03-30');
  });
});

describe('time zones differ', () => {
  it('the same instant is before cutoff in Warsaw but after cutoff in Kyiv', () => {
    // 15:30Z on Tue 2026-11-24 is 16:30 in Warsaw and 17:30 in Kyiv.
    expect(shipDayFor(at('2026-11-24T15:30:00Z'), warsaw)).toBe('2026-11-24');
    expect(shipDayFor(at('2026-11-24T15:30:00Z'), kyiv)).toBe('2026-11-25');
  });
});

describe('nextCutoff', () => {
  it('reports time left until today cutoff', () => {
    const r = nextCutoff(at('2026-11-24T15:00:00Z'), warsaw);
    expect(r.shipDay).toBe('2026-11-24');
    expect(r.msLeft).toBe(60 * 60 * 1000);
  });
  it('after cutoff points at the next working day', () => {
    const r = nextCutoff(at('2026-11-27T16:30:00Z'), warsaw);
    expect(r.shipDay).toBe('2026-11-30');
    expect(r.cutoffAt.toISOString()).toBe('2026-11-30T16:00:00.000Z');
  });
});

describe('validation helpers', () => {
  it('rejects bad zones and cutoffs', () => {
    expect(isValidTimeZone('Europe/Kyiv')).toBe(true);
    expect(isValidTimeZone('Mars/Olympus')).toBe(false);
    expect(isValidCutoff('17:00')).toBe(true);
    expect(isValidCutoff('25:00')).toBe(false);
    expect(isValidCutoff('7:00')).toBe(false);
    expect(isValidCutoff('17:60')).toBe(false);
  });
  it('nextWorkingDay throws on a calendar with no working days', () => {
    expect(() => nextWorkingDay('2026-11-24', { ...warsaw, workingDays: [] })).toThrow();
  });
  it('daysBetween counts calendar days', () => {
    expect(daysBetween('2026-11-24', '2026-12-24')).toBe(30);
    expect(daysBetween('2026-12-24', '2026-11-24')).toBe(-30);
  });
});
