import { describe, expect, it } from 'vitest';
import { countRequiresApproval, evaluateCountLine, requiresApproval } from './count';
import { pickWaveOrders, sortForRereserve, type ReadyOrder, type WaitingOrder } from './priority';
import { fits, loadOf, sortRoute, suggestCells, type CellCandidate } from './putaway';
import { nextWaveDueAt, waveTrigger } from './wave';
import {
  backoffMs,
  canSendStockNow,
  isNewerVersion,
  nextStockSendAt,
  signWebhook,
  verifyWebhook,
} from './webhook';

const t = (iso: string): Date => new Date(iso);

describe('re-reserve priority (acceptance #5)', () => {
  it('express first, then earliest, then id', () => {
    const orders: WaitingOrder[] = [
      { id: 'c', deliveryMethod: 'standard', receivedAt: t('2026-01-01T10:00:00Z') },
      { id: 'b', deliveryMethod: 'express', receivedAt: t('2026-01-01T12:00:00Z') },
      { id: 'a', deliveryMethod: 'standard', receivedAt: t('2026-01-01T09:00:00Z') },
      { id: 'e', deliveryMethod: 'express', receivedAt: t('2026-01-01T11:00:00Z') },
      { id: 'd', deliveryMethod: 'standard', receivedAt: t('2026-01-01T09:00:00Z') },
    ];
    expect(sortForRereserve(orders).map((o) => o.id)).toEqual(['e', 'b', 'a', 'd', 'c']);
  });
});

describe('wave priority', () => {
  const o = (id: string, cutoff: string, express: boolean, rec: string): ReadyOrder => ({
    id,
    deliveryMethod: express ? 'express' : 'standard',
    receivedAt: t(rec),
    targetCutoffAt: t(cutoff),
  });
  it('nearest cutoff first, then express, then arrival', () => {
    const orders = [
      o('late-express', '2026-01-02T16:00:00Z', true, '2026-01-01T08:00:00Z'),
      o('soon-std', '2026-01-01T16:00:00Z', false, '2026-01-01T07:00:00Z'),
      o('soon-express', '2026-01-01T16:00:00Z', true, '2026-01-01T09:00:00Z'),
      o('soon-std-early', '2026-01-01T16:00:00Z', false, '2026-01-01T06:00:00Z'),
    ];
    expect(pickWaveOrders(orders, 10).map((x) => x.id)).toEqual([
      'soon-express',
      'soon-std-early',
      'soon-std',
      'late-express',
    ]);
    expect(pickWaveOrders(orders, 2)).toHaveLength(2);
    expect(pickWaveOrders(orders, -1)).toHaveLength(0);
  });
});

describe('wave trigger', () => {
  const base = { lastWaveAt: t('2026-01-01T14:45:00Z'), intervalMin: 15, readyThreshold: 50 };
  it('timer: 14:59:59.999 does not fire, 15:00 fires', () => {
    expect(waveTrigger({ ...base, now: t('2026-01-01T14:59:59.999Z'), readyCount: 3 })).toBeNull();
    expect(waveTrigger({ ...base, now: t('2026-01-01T15:00:00.000Z'), readyCount: 3 })).toBe('timer');
    expect(nextWaveDueAt(base.lastWaveAt, 15).toISOString()).toBe('2026-01-01T15:00:00.000Z');
  });
  it('threshold: 49 waits, 50 and 51 fire at once', () => {
    const now = t('2026-01-01T14:46:00Z');
    expect(waveTrigger({ ...base, now, readyCount: 49 })).toBeNull();
    expect(waveTrigger({ ...base, now, readyCount: 50 })).toBe('threshold');
    expect(waveTrigger({ ...base, now, readyCount: 51 })).toBe('threshold');
  });
  it('never forms an empty wave', () => {
    expect(waveTrigger({ ...base, now: t('2026-01-01T18:00:00Z'), readyCount: 0 })).toBeNull();
  });
});

describe('count thresholds (acceptance #9)', () => {
  it('exactly 5 units is auto-approved, 6 needs approval', () => {
    expect(requiresApproval(100, 95)).toBe(false);
    expect(requiresApproval(100, 94)).toBe(true);
    expect(requiresApproval(100, 105)).toBe(false);
    expect(requiresApproval(100, 106)).toBe(true);
  });
  it('exactly 10% is auto-approved, just above needs approval', () => {
    expect(requiresApproval(30, 27)).toBe(false); // 10%
    expect(requiresApproval(20, 17)).toBe(true); // 15%
    expect(requiresApproval(1000, 1005)).toBe(false); // 0.5%, 5 units
    expect(requiresApproval(40, 36)).toBe(false); // exactly 10%
    expect(requiresApproval(39, 35)).toBe(true); // 10.26%
  });
  it('a discrepancy of 7 always needs approval', () => {
    expect(evaluateCountLine(20, 13)).toEqual({ systemQty: 20, countedQty: 13, delta: -7, requiresApproval: true });
  });
  it('system 0: any find needs approval, none found does not', () => {
    expect(requiresApproval(0, 1)).toBe(true);
    expect(requiresApproval(0, 0)).toBe(false);
  });
  it('a count needs approval if any line does', () => {
    expect(countRequiresApproval([evaluateCountLine(10, 10), evaluateCountLine(10, 3)])).toBe(true);
    expect(countRequiresApproval([evaluateCountLine(10, 10)])).toBe(false);
  });
});

describe('webhook coalescing (5 s window)', () => {
  const last = t('2026-01-01T10:00:00.000Z');
  it('4.999 s after the last send waits, 5.000 s sends', () => {
    expect(canSendStockNow(t('2026-01-01T10:00:04.999Z'), last, 5000)).toBe(false);
    expect(canSendStockNow(t('2026-01-01T10:00:05.000Z'), last, 5000)).toBe(true);
    expect(nextStockSendAt(t('2026-01-01T10:00:01.000Z'), last, 5000).toISOString()).toBe('2026-01-01T10:00:05.000Z');
    expect(nextStockSendAt(t('2026-01-01T10:00:09.000Z'), last, 5000).toISOString()).toBe('2026-01-01T10:00:09.000Z');
  });
  it('first event sends immediately', () => {
    expect(canSendStockNow(last, null, 5000)).toBe(true);
    expect(nextStockSendAt(last, null, 5000)).toEqual(last);
  });
  it('versions: only strictly newer is accepted', () => {
    expect(isNewerVersion(3, 2)).toBe(true);
    expect(isNewerVersion(2, 2)).toBe(false);
    expect(isNewerVersion(1, 2)).toBe(false);
    expect(isNewerVersion(1, null)).toBe(true);
  });
  it('backoff doubles and caps', () => {
    expect([1, 2, 3, 4, 10].map((a) => backoffMs(a, 1000, 6000))).toEqual([1000, 2000, 4000, 6000, 6000]);
  });
});

describe('webhook signatures', () => {
  const body = JSON.stringify({ a: 1 });
  const sig = signWebhook('s3cret', body, 1_700_000_000);
  it('verifies a valid signature', () => {
    expect(verifyWebhook('s3cret', body, sig, 1_700_000_010, 300)).toEqual({ ok: true, timestamp: 1_700_000_000 });
  });
  it('rejects tampered body, wrong secret, stale timestamp, malformed header', () => {
    expect(verifyWebhook('s3cret', `${body} `, sig, 1_700_000_010, 300)).toEqual({ ok: false, reason: 'mismatch' });
    expect(verifyWebhook('other', body, sig, 1_700_000_010, 300)).toEqual({ ok: false, reason: 'mismatch' });
    expect(verifyWebhook('s3cret', body, sig, 1_700_000_301, 300)).toEqual({ ok: false, reason: 'stale' });
    expect(verifyWebhook('s3cret', body, undefined, 1_700_000_000, 300)).toEqual({ ok: false, reason: 'malformed' });
    expect(verifyWebhook('s3cret', body, sig.replace('t=', 't=1'), 1_700_000_000, 300).ok).toBe(false);
    expect(verifyWebhook('s3cret', body, `${sig}\r\nx: y`, 1_700_000_000, 300)).toEqual({ ok: false, reason: 'malformed' });
  });
});

describe('putaway suggestion and route', () => {
  const cell = (o: Partial<CellCandidate> & { cellId: string }): CellCandidate => ({
    code: o.cellId,
    walkOrder: 10,
    blocked: false,
    capacityVolumeCm3: 10_000,
    capacityWeightG: 10_000,
    usedVolumeCm3: 0,
    usedWeightG: 0,
    holdsSameBatch: false,
    holdsSameSku: false,
    isEmpty: true,
    ...o,
  });
  const load = loadOf(10, 100, 100); // 1000 cm3, 1000 g
  it('prefers the same batch, then same SKU, then empty, by walk order', () => {
    const cells = [
      cell({ cellId: 'empty1', walkOrder: 1 }),
      cell({ cellId: 'sku', holdsSameSku: true, isEmpty: false, walkOrder: 5 }),
      cell({ cellId: 'batch', holdsSameBatch: true, holdsSameSku: true, isEmpty: false, walkOrder: 9 }),
      cell({ cellId: 'empty0', walkOrder: 0 }),
    ];
    expect(suggestCells(cells, load).map((c) => c.cellId)).toEqual(['batch', 'sku', 'empty0', 'empty1']);
  });
  it('skips blocked cells and cells without room (volume or weight), boundary inclusive', () => {
    const cells = [
      cell({ cellId: 'blocked', blocked: true, holdsSameBatch: true }),
      cell({ cellId: 'heavy', usedWeightG: 9_001, holdsSameBatch: true }),
      cell({ cellId: 'exact', usedVolumeCm3: 9_000, usedWeightG: 9_000 }),
    ];
    expect(suggestCells(cells, load).map((c) => c.cellId)).toEqual(['exact']);
    expect(fits(cells[2] as CellCandidate, loadOf(11, 100, 100))).toBe(false);
  });
  it('route follows walk order, then cell code', () => {
    const stops = [
      { walkOrder: 3, cellCode: 'B' },
      { walkOrder: 1, cellCode: 'Z' },
      { walkOrder: 3, cellCode: 'A' },
    ];
    expect(sortRoute(stops).map((s) => s.cellCode)).toEqual(['Z', 'A', 'B']);
  });
});
