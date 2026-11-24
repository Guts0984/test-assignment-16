// The demo shop page: send orders and watch received webhooks with their versions.
import { type ShopCreds, type Store } from './store';

/** Every interpolated value goes through this: the page shows untrusted webhook data. */
export const escapeHtml = (v: unknown): string =>
  String(v ?? '').replace(
    /[&<>"'`]/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '`': '&#96;' })[c] ?? c,
  );

const row = (cells: readonly unknown[]): string =>
  `<tr>${cells.map((c) => `<td>${escapeHtml(c)}</td>`).join('')}</tr>`;

export const renderPage = (store: Store, chaos: boolean, flash: string | null): string => {
  const shops = store.shops();
  const hooks = store.received().slice(-200).reverse();
  const shopForm = (s: ShopCreds) => `
    <form method="post" action="/ui/send" class="send">
      <input type="hidden" name="shop" value="${escapeHtml(s.code)}">
      <strong>${escapeHtml(s.code)}</strong>
      <label>Orders <input name="count" type="number" min="1" max="200" value="1"></label>
      <button type="submit">Send</button>
    </form>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Demo shop</title>
<style>
  :root { color-scheme: light dark; --bg:#fff; --fg:#111; --muted:#666; --line:#ddd; }
  @media (prefers-color-scheme: dark) { :root { --bg:#111; --fg:#eee; --muted:#999; --line:#333; } }
  body { font: 14px/1.4 system-ui, sans-serif; margin: 16px; background: var(--bg); color: var(--fg); }
  table { border-collapse: collapse; width: 100%; } td, th { border-bottom: 1px solid var(--line); padding: 4px 6px; text-align: left; }
  .send { display: flex; gap: 8px; align-items: center; margin: 4px 0; } .muted { color: var(--muted); }
  .wrap { overflow-x: auto; }
</style></head><body>
<h1>Demo shop</h1>
<p class="muted">Chaos mode: <strong>${chaos ? 'on' : 'off'}</strong>. ${flash === null ? '' : escapeHtml(flash)}</p>
<h2>Send orders</h2>${shops.map(shopForm).join('')}
<h2>Webhooks received (latest 200)</h2>
<div class="wrap"><table><thead><tr><th>#</th><th>Shop</th><th>Type</th><th>Stream</th><th>Version</th><th>Signature</th><th>Outcome</th><th>Data</th><th>At</th></tr></thead>
<tbody>${hooks.map((h) => row([h.seq, h.shopCode, h.type, h.stream, h.version, h.signature, h.outcome, JSON.stringify(h.data), h.receivedAt])).join('')}</tbody></table></div>
</body></html>`;
};
