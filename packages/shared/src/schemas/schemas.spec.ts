import { describe, expect, it } from 'vitest';
import { text } from './common';
import { createOrderSchema } from './orders';
import { moveSchema, receiptLineSchema, reportQuerySchema, testClockSchema } from './floor';
import { createCellsSchema, createShopSchema, createSkuSchema, createWarehouseSchema, roleAssignmentSchema } from './setup';

const order = {
  externalNumber: 'SHOP-1001',
  deliveryMethod: 'express',
  address: { name: 'Ann', line1: 'Main 1', city: 'Lviv', postalCode: '79000', country: 'ua' },
  lines: [{ sku: 'SKU-1', qty: 2 }],
};

describe('order schema', () => {
  it('accepts a valid order and upper-cases the country', () => {
    const r = createOrderSchema.safeParse(order);
    expect(r.success && r.data.address.country).toBe('UA');
  });
  it.each([
    ['zero qty', { lines: [{ sku: 'A', qty: 0 }] }],
    ['negative qty', { lines: [{ sku: 'A', qty: -1 }] }],
    ['fractional qty', { lines: [{ sku: 'A', qty: 1.5 }] }],
    ['overflow qty', { lines: [{ sku: 'A', qty: 2 ** 53 }] }],
    ['no lines', { lines: [] }],
    ['duplicate lines', { lines: [{ sku: 'A', qty: 1 }, { sku: 'A', qty: 2 }] }],
    ['10 000 lines', { lines: Array.from({ length: 10_000 }, (_, i) => ({ sku: `S${i}`, qty: 1 })) }],
    ['unknown delivery method', { deliveryMethod: 'teleport' }],
    ['missing address', { address: undefined }],
    ['mass assignment: shopId', { shopId: 'x' }],
    ['mass assignment: status', { status: 'shipped' }],
    ['sql in order number', { externalNumber: "1'; DROP TABLE orders;--" }],
    ['crlf in order number', { externalNumber: 'A\r\nB' }],
  ])('rejects %s', (_name, patch) => {
    expect(createOrderSchema.safeParse({ ...order, ...patch }).success).toBe(false);
  });
  it('rejects null bytes and control chars in free text but keeps unicode', () => {
    expect(text(50).safeParse('a\u0000b').success).toBe(false);
    expect(text(50).safeParse('a\u0007b').success).toBe(false);
    expect(text(50).safeParse('  Zoë <script>  ').success).toBe(true);
    // NFD "e + combining acute" becomes one NFC code point
    expect(text(50).parse('é')).toBe('é');
  });
  it('rejects overlong strings', () => {
    expect(text(10).safeParse('x'.repeat(11)).success).toBe(false);
  });
});

describe('setup schemas', () => {
  const wh = {
    code: 'WAW',
    name: 'Warsaw',
    country: 'PL',
    timeZone: 'Europe/Warsaw',
    cutoffLocal: '17:00',
    workingDays: [1, 2, 3, 4, 5],
  };
  it('accepts a warehouse and defaults holidays', () => {
    const r = createWarehouseSchema.safeParse(wh);
    expect(r.success && r.data.holidays).toEqual([]);
  });
  it.each([
    ['invalid tz', { timeZone: 'Europe/Atlantis' }],
    ['cutoff 25:00', { cutoffLocal: '25:00' }],
    ['no working days', { workingDays: [] }],
    ['working day 8', { workingDays: [8] }],
    ['duplicate working days', { workingDays: [1, 1] }],
    ['bad holiday', { holidays: ['2026-02-30'] }],
    ['lower-case code', { code: 'waw' }],
  ])('rejects warehouse with %s', (_n, patch) => {
    expect(createWarehouseSchema.safeParse({ ...wh, ...patch }).success).toBe(false);
  });
  it('rejects cell capacity <= 0 and duplicate cell codes', () => {
    const c = { code: 'A-1', walkOrder: 1, capacityVolumeCm3: 1000, capacityWeightG: 1000 };
    expect(createCellsSchema.safeParse({ cells: [c] }).success).toBe(true);
    expect(createCellsSchema.safeParse({ cells: [{ ...c, capacityVolumeCm3: 0 }] }).success).toBe(false);
    expect(createCellsSchema.safeParse({ cells: [c, c] }).success).toBe(false);
  });
  it('shop webhook must be http(s)', () => {
    const s = { code: 'S1', name: 'Shop', webhookUrl: 'https://x.test/h', minShelfLifeDays: 30 };
    expect(createShopSchema.safeParse(s).success).toBe(true);
    expect(createShopSchema.safeParse({ ...s, webhookUrl: 'file:///etc/passwd' }).success).toBe(false);
    expect(createShopSchema.safeParse({ ...s, webhookUrl: 'javascript:alert(1)' }).success).toBe(false);
  });
  it('admin role is global, others need a warehouse', () => {
    const wid = '00000000-0000-4000-8000-000000000001';
    expect(roleAssignmentSchema.safeParse({ role: 'admin', warehouseId: null }).success).toBe(true);
    expect(roleAssignmentSchema.safeParse({ role: 'admin', warehouseId: wid }).success).toBe(false);
    expect(roleAssignmentSchema.safeParse({ role: 'picker', warehouseId: null }).success).toBe(false);
  });
  it('sku dimensions must be positive', () => {
    const s = { code: 'A', name: 'n', barcode: 'B', weightG: 1, lengthMm: 1, widthMm: 1, heightMm: 1, tracksExpiry: false };
    expect(createSkuSchema.safeParse(s).success).toBe(true);
    expect(createSkuSchema.safeParse({ ...s, weightG: 0 }).success).toBe(false);
  });
});

describe('floor schemas', () => {
  it('batch code and expiry go together', () => {
    const base = { barcode: 'B', qty: 1, idempotencyKey: 'key-12345' };
    expect(receiptLineSchema.safeParse(base).success).toBe(true);
    expect(receiptLineSchema.safeParse({ ...base, batchCode: 'L1' }).success).toBe(false);
    expect(receiptLineSchema.safeParse({ ...base, batchCode: 'L1', expiresOn: '2027-01-01' }).success).toBe(true);
  });
  it('move between the same cell is rejected', () => {
    const m = {
      fromCellCode: 'A-1',
      toCellCode: 'A-1',
      skuId: '00000000-0000-4000-8000-000000000001',
      batchId: '00000000-0000-4000-8000-000000000002',
      qty: 1,
      idempotencyKey: 'key-12345',
    };
    expect(moveSchema.safeParse(m).success).toBe(false);
  });
  it('report period: inverted and oversized periods are rejected', () => {
    expect(reportQuerySchema.safeParse({ from: '2026-01-01', to: '2026-03-31' }).success).toBe(true);
    expect(reportQuerySchema.safeParse({ from: '2026-03-31', to: '2026-01-01' }).success).toBe(false);
    expect(reportQuerySchema.safeParse({ from: '2024-01-01', to: '2026-01-01' }).success).toBe(false);
  });
  it('test clock takes exactly one operation', () => {
    expect(testClockSchema.safeParse({ advanceMs: 1000 }).success).toBe(true);
    expect(testClockSchema.safeParse({}).success).toBe(false);
    expect(testClockSchema.safeParse({ advanceMs: 1, reset: true }).success).toBe(false);
  });
});
