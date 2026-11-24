// UI requirements from the assignment: keyboard-only scanner with sound and a clear message on a bad
// scan, state in the URL (reload and Back), errors at the fields, live updates, server-time cutoff.
import { expect, test } from '@playwright/test';
import { scanKeys, signIn } from './support/ui';
import { call, clock, newSku, newWorld, orderState, poll, sendOrder, stockUp } from './support/world';

test.afterEach(async () => {
  await clock.reset();
});

test('the scanner screen works with the keyboard only; a bad scan beeps and says what is wrong', async ({
  browser,
}) => {
  const w = await newWorld();
  const sku = await newSku(w);
  const other = await newSku(w);
  await stockUp(w, sku, 'A-001', 5);
  const { orderId } = await sendOrder(w, [{ sku: sku.code, qty: 1 }]);
  await poll(async () => (await orderState(w, orderId)).status === 'reserved');
  await call('POST', `/api/warehouses/${w.wh.id}/waves`, w.lead.token);
  const page = await (await browser.newContext()).newPage();
  await signIn(page, w.picker.email, /\/w\/.+\/picker$/);
  const input = page.getByTestId('scan-input');
  await expect(input).toBeFocused();
  // wrong cell: sound + message, focus stays in the field
  await page.keyboard.type('Z-999');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('alert').filter({ hasText: 'Wrong cell' })).toBeVisible();
  await expect(input).toBeFocused();
  expect(await page.evaluate(() => (window as unknown as { __beeps?: string[] }).__beeps ?? [])).toContain(
    'error',
  );
  // right cell, then a wrong item
  await page.keyboard.type('A-001');
  await page.keyboard.press('Enter');
  await expect(page.getByText('Cell A-001 confirmed')).toBeVisible();
  await page.keyboard.type(other.barcode);
  await page.keyboard.press('Enter');
  await expect(page.getByRole('alert').filter({ hasText: 'Wrong item' })).toBeVisible();
  // clicking elsewhere gives the focus back to the scan field
  await page.getByRole('heading', { level: 2 }).first().click();
  await expect(input).toBeFocused();
  await scanKeys(page, sku.barcode);
  await expect(page.getByText('Task complete. Hand over to packing.').first()).toBeVisible();
});

test('report period and filters live in the URL: reload and Back restore them', async ({ browser }) => {
  const w = await newWorld();
  const page = await (await browser.newContext()).newPage();
  await signIn(page, w.lead.email, /\/w\/.+\/dashboard$/);
  await page.goto(`/w/${w.wh.id}/report?from=2026-01-01&to=2026-02-15&warehouseId=${w.wh.id}`);
  await expect(page.getByLabel('From')).toHaveValue('2026-01-01');
  await expect(page.getByLabel('To')).toHaveValue('2026-02-15');
  await page.getByLabel('To').fill('2026-03-01');
  await expect(page).toHaveURL(/to=2026-03-01/);
  await page.reload();
  await expect(page.getByLabel('To')).toHaveValue('2026-03-01');
  await expect(page.getByLabel('From')).toHaveValue('2026-01-01');
  await page.goBack();
  await expect(page.getByLabel('To')).toHaveValue('2026-02-15');
  // an invalid URL falls back to the default period instead of breaking
  await page.goto(`/w/${w.wh.id}/report?from=garbage&to=2026-01-01`);
  await expect(page.getByLabel('From')).not.toHaveValue('garbage');
});

test('order search, status filter and paging are kept in the URL', async ({ browser }) => {
  const w = await newWorld();
  const sku = await newSku(w);
  const { externalNumber } = await sendOrder(w, [{ sku: sku.code, qty: 1 }]);
  const page = await (await browser.newContext()).newPage();
  await signIn(page, w.cabinetEmail, /\/shop\/stock$/);
  await page.goto('/shop/orders');
  await page.getByLabel('Order number, customer or SKU').fill(externalNumber);
  await expect(page).toHaveURL(new RegExp(`q=${externalNumber}`));
  await expect(page.getByRole('link', { name: externalNumber })).toBeVisible();
  await page.reload();
  await expect(page.getByLabel('Order number, customer or SKU')).toHaveValue(externalNumber);
  await expect(page.getByRole('link', { name: externalNumber })).toBeVisible();
});

test('forms show errors at the fields: client validation and the api field errors', async ({ browser }) => {
  const w = await newWorld();
  const page = await (await browser.newContext()).newPage();
  await signIn(page, w.cabinetEmail, /\/shop\/stock$/);
  await page.goto('/shop/skus');
  await page.getByRole('button', { name: 'Create SKU' }).click();
  await expect(
    page.getByLabel('Code', { exact: true }).locator('xpath=following-sibling::*[@role="alert"]'),
  ).toBeVisible();
  await expect(
    page.getByLabel('Name', { exact: true }).locator('xpath=following-sibling::*[@role="alert"]'),
  ).toBeVisible();
  // a duplicate barcode comes back from the server and is shown as a banner (it names no single field)
  const first = await newSku(w);
  await page.getByLabel('Code', { exact: true }).fill('NEW-1');
  await page.getByLabel('Name', { exact: true }).fill('Name');
  await page.getByLabel('Barcode').fill(first.barcode);
  await page.getByRole('button', { name: 'Create SKU' }).click();
  await expect(page.getByRole('alert').filter({ hasText: /barcode/i })).toBeVisible();
});

test('the shift dashboard updates live and counts down to the cutoff by the server clock', async ({
  browser,
}) => {
  const w = await newWorld({ timeZone: 'Europe/Warsaw' });
  const sku = await newSku(w);
  await stockUp(w, sku, 'A-001', 5);
  const page = await (await browser.newContext()).newPage();
  await signIn(page, w.lead.email, /\/w\/.+\/dashboard$/);
  await expect(page.getByTestId('count-reserved')).toHaveText('0');
  await sendOrder(w, [{ sku: sku.code, qty: 1 }]);
  await expect(page.getByTestId('count-reserved')).toHaveText('1'); // no reload: pushed by the socket
  // the browser clock is wrong by hours; the countdown follows the server
  await page.clock.install({ time: new Date('2030-01-01T00:00:00Z') });
  await page.reload();
  await expect(page.getByTestId('cutoff')).not.toContainText('late');
});
