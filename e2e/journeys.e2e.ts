// The four journeys from the assignment, through the real browser UI on the full compose stack.
import { expect, test } from '@playwright/test';
import { scanKeys, signIn } from './support/ui';
import {
  BASE,
  call,
  clock,
  newSku,
  newWorld,
  orderState,
  poll,
  sendOrder,
  STUB,
  stockUp,
  stubHooks,
  uid,
  type World,
} from './support/world';

test.afterEach(async () => {
  await clock.reset();
});

const ALL_STATUSES = ['received', 'reserved', 'in_wave', 'picking', 'picked', 'packed', 'shipped'];
const shopStatuses = async (w: World, orderId: string) =>
  (await stubHooks(w.shop.code))
    .filter(
      (h) => h.outcome === 'accepted' && h.type === 'order.status_changed' && h.stream === `order:${orderId}`,
    )
    .sort((a, b) => a.version - b.version);

test('E2E-1: stub order -> reserve -> wave -> scanner picking -> pack -> label -> shipment -> the shop got every status webhook', async ({
  browser,
}) => {
  // a fixed working-day morning, so the order is packed before the cutoff whatever the real time is
  await clock.set('2026-03-24T09:00:00Z');
  await new Promise((r) => setTimeout(r, 1500));
  const w = await newWorld();
  const sku = await newSku(w);
  await stockUp(w, sku, 'A-001', 10);

  // 1. the shop stub page sends an order with its button
  const stubPage = await (await browser.newContext()).newPage();
  await stubPage.goto(STUB);
  const form = stubPage.locator('form.send', { has: stubPage.locator('strong', { hasText: w.shop.code }) });
  await form.getByRole('button', { name: 'Send' }).click();
  await expect(stubPage.getByText('Sent 1 of 1 orders.')).toBeVisible();
  const order = await poll(
    async () => (await call('GET', '/api/shop/v1/orders?limit=5', w.shop.apiKey)).body.items[0],
  );
  const orderId = order.id as string;
  const number = order.externalNumber as string;
  const lines = (await orderState(w, orderId)).lines as { qty: number }[];
  const units = lines.reduce((s, l) => s + l.qty, 0);

  // 2. reserve (worker)
  await poll(async () => (await orderState(w, orderId)).status === 'reserved');

  // 3. the shift lead starts a wave from the dashboard; counts update live, no reload
  const leadPage = await (await browser.newContext()).newPage();
  await signIn(leadPage, w.lead.email, /\/w\/.+\/dashboard$/);
  await expect(leadPage.getByTestId('count-reserved')).toHaveText('1');
  await leadPage.getByRole('button', { name: 'Start a wave now' }).click();
  await expect(leadPage.getByTestId('count-in_wave')).toHaveText('1');

  // 4. the picker works with the keyboard only: cell, then item, units times
  const pickerPage = await (await browser.newContext()).newPage();
  await signIn(pickerPage, w.picker.email, /\/w\/.+\/picker$/);
  await expect(pickerPage.getByTestId('instruction')).toContainText('Go to cell A-001');
  await scanKeys(pickerPage, 'A-001');
  await expect(pickerPage.getByTestId('instruction')).toContainText('Scan');
  for (let i = 0; i < units; i += 1) {
    await scanKeys(pickerPage, sku.barcode);
    await pickerPage.waitForTimeout(300);
  }
  await expect(pickerPage.getByText('Task complete. Hand over to packing.').first()).toBeVisible();
  await poll(async () => (await orderState(w, orderId)).status === 'picked');

  // 5. packing: scan the order, the label opens as a PDF
  const packerPage = await (await browser.newContext()).newPage();
  await signIn(packerPage, w.packer.email, /\/w\/.+\/packer$/);
  await packerPage.getByTestId('pack-input').fill(number);
  await packerPage.getByTestId('pack-input').press('Enter');
  await expect(packerPage.getByText(`Packed ${number}`)).toBeVisible();
  const [popup] = await Promise.all([
    packerPage.waitForEvent('popup'),
    packerPage.getByRole('button', { name: 'Open the label (PDF)' }).click(),
  ]);
  expect(popup).toBeTruthy(); // the label opened in a new tab
  const pdf = await fetch(`${BASE}/api/warehouses/${w.wh.id}/orders/${orderId}/label`, {
    headers: { authorization: `Bearer ${w.packer.token}` },
  });
  expect(pdf.status).toBe(200);
  expect(pdf.headers.get('content-type')).toBe('application/pdf');
  expect(
    Buffer.from(await pdf.arrayBuffer())
      .subarray(0, 4)
      .toString(),
  ).toBe('%PDF');

  // 6. shipment from the shift dashboard
  await leadPage.getByRole('button', { name: 'Ship packed orders for today' }).click();
  await poll(async () => (await orderState(w, orderId)).status === 'shipped');

  // 7. the shop received every status, in order, validly signed
  await poll(async () => (await shopStatuses(w, orderId)).length >= ALL_STATUSES.length);
  const got = await shopStatuses(w, orderId);
  expect(got.map((h) => h.data.status)).toEqual(ALL_STATUSES);
  expect(got.map((h) => h.version)).toEqual([1, 2, 3, 4, 5, 6, 7]);
});

test('E2E-2: shortage while picking -> the cell goes to a stock count -> the order is picked from another cell', async ({
  browser,
}) => {
  const w = await newWorld();
  const sku = await newSku(w);
  await stockUp(w, sku, 'A-001', 3);
  await stockUp(w, sku, 'A-004', 5);
  const { orderId } = await sendOrder(w, [{ sku: sku.code, qty: 2 }]);
  await poll(async () => (await orderState(w, orderId)).status === 'reserved');
  await call('POST', `/api/warehouses/${w.wh.id}/waves`, w.lead.token);

  const pickerPage = await (await browser.newContext()).newPage();
  await signIn(pickerPage, w.picker.email, /\/w\/.+\/picker$/);
  await expect(pickerPage.getByTestId('instruction')).toContainText('Go to cell A-001');
  await scanKeys(pickerPage, 'A-001');
  await pickerPage.getByRole('button', { name: 'Not enough in the cell' }).click();
  await pickerPage.getByLabel('Units found in the cell').fill('0');
  await pickerPage.getByRole('button', { name: 'Confirm shortage' }).click();
  await expect(pickerPage.getByText('Shortage recorded')).toBeVisible();
  await expect(pickerPage.getByTestId('instruction')).toContainText('Go to cell A-004');

  // the shift lead sees the cell in a stock count
  const leadPage = await (await browser.newContext()).newPage();
  await signIn(leadPage, w.lead.email, /\/w\/.+\/dashboard$/);
  await leadPage.goto(`/w/${w.wh.id}/counts`);
  await expect(leadPage.getByRole('row', { name: /A-001.*shortage/ })).toBeVisible();

  // another picker-free path: the same picker finishes from the other cell
  await scanKeys(pickerPage, 'A-004');
  await scanKeys(pickerPage, sku.barcode);
  await pickerPage.waitForTimeout(300);
  await scanKeys(pickerPage, sku.barcode);
  await expect(pickerPage.getByText('Task complete. Hand over to packing.').first()).toBeVisible();
  await poll(async () => (await orderState(w, orderId)).status === 'picked');
});

test('E2E-3: an order waits for stock -> a delivery is received and put away -> it is reserved and the shop sees the new stock live', async ({
  browser,
}) => {
  const w = await newWorld();
  const sku = await newSku(w);
  const { orderId } = await sendOrder(w, [{ sku: sku.code, qty: 1 }]);
  await poll(async () => (await orderState(w, orderId)).status === 'awaiting_stock');

  // the shop cabinet is open and stays open
  const shopPage = await (await browser.newContext()).newPage();
  await signIn(shopPage, w.cabinetEmail, /\/shop\/stock$/);
  const row = shopPage.getByTestId(`stock-${sku.code}-${w.wh.code}`);
  await expect(row).toBeVisible();
  await expect(row).toContainText('0');

  // the storekeeper receives 5 units and puts them away
  const storePage = await (await browser.newContext()).newPage();
  await signIn(storePage, w.store.email, /\/w\/.+\/receiving$/);
  await storePage.getByLabel('Shop').selectOption({ label: `${w.shop.code} - E2E shop ${w.shop.code}` });
  await storePage.getByRole('button', { name: 'Start receiving' }).click();
  await storePage.getByLabel('Barcode').fill(sku.barcode);
  await storePage.getByLabel('Quantity').fill('5');
  await storePage.getByRole('button', { name: 'Add to receipt' }).click();
  await expect(storePage.getByText('Scanned (1)')).toBeVisible();
  await storePage.getByRole('button', { name: 'Close receipt' }).click();
  await storePage.goto(`/w/${w.wh.id}/putaway`);
  await storePage.getByRole('button', { name: new RegExp(`${sku.code}.*5`) }).click();
  await storePage.getByLabel('Scan the cell').fill('A-002');
  await storePage.getByRole('button', { name: 'Confirm placement' }).click();

  // the order is reserved and the shop's page updated by itself (no reload)
  await poll(async () => (await orderState(w, orderId)).status === 'reserved');
  await expect(row).toContainText('4'); // available = 5 on the shelf - 1 reserved
  await shopPage.goto('/shop/orders');
  await expect(shopPage.getByRole('cell', { name: 'Reserved' }).first()).toBeVisible();
});

test('E2E-4: packed after the cutoff -> the clocks change -> the order leaves on the next working day', async ({
  browser,
}) => {
  const w = await newWorld({ timeZone: 'Europe/Warsaw' });
  const sku = await newSku(w);
  await stockUp(w, sku, 'A-001', 3);
  const { orderId, externalNumber } = await sendOrder(w, [{ sku: sku.code, qty: 1 }]);
  await poll(async () => (await orderState(w, orderId)).status === 'reserved');
  await call('POST', `/api/warehouses/${w.wh.id}/waves`, w.lead.token);
  const task = (await call('POST', `/api/warehouses/${w.wh.id}/tasks/next`, w.picker.token)).body;
  await call('POST', `/api/warehouses/${w.wh.id}/tasks/${task.id}/scan`, w.picker.token, {
    lineId: task.lines[0].lineId,
    cellCode: 'A-001',
    barcode: sku.barcode,
    idempotencyKey: uid('k').toLowerCase().padEnd(10, 'x'),
  });

  // Friday 27 March 2026, 17:01 in Warsaw (CET): after the 17:00 cutoff; clocks change on Sunday
  await clock.set('2026-03-27T16:01:00Z');
  await new Promise((r) => setTimeout(r, 1500));
  const packerPage = await (await browser.newContext()).newPage();
  await signIn(packerPage, w.packer.email, /\/w\/.+\/packer$/);
  await packerPage.getByTestId('pack-input').fill(externalNumber);
  await packerPage.getByTestId('pack-input').press('Enter');
  await expect(packerPage.getByText('Ships on 2026-03-30.')).toBeVisible();

  const leadPage = await (await browser.newContext()).newPage();
  await signIn(leadPage, w.lead.email, /\/w\/.+\/dashboard$/);
  await expect(leadPage.getByTestId('cutoff')).toContainText('Next cutoff 2026-03-30');
  await leadPage.getByRole('button', { name: 'Ship packed orders for today' }).click();
  await new Promise((r) => setTimeout(r, 800));
  expect((await orderState(w, orderId)).status).toBe('packed');

  // Monday 30 March, 09:00 UTC (11:00 CEST): the order leaves
  await clock.set('2026-03-30T09:00:00Z');
  await new Promise((r) => setTimeout(r, 1500));
  const leadAgain = await (await browser.newContext()).newPage();
  await signIn(leadAgain, w.lead.email, /\/w\/.+\/dashboard$/);
  await leadAgain.getByRole('button', { name: 'Ship packed orders for today' }).click();
  await poll(async () => (await orderState(w, orderId)).status === 'shipped');
  await poll(async () => (await shopStatuses(w, orderId)).some((h) => h.data.status === 'shipped')).catch(
    async (e) => {
      console.log(
        'DEBUG hooks',
        JSON.stringify(
          (await stubHooks(w.shop.code)).map((h) => [
            h.outcome,
            h.stream.slice(0, 12),
            h.version,
            h.data.status,
          ]),
        ),
      );
      throw e;
    },
  );
});
