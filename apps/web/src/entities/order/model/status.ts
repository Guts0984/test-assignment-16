export const STATUS_LABEL: Readonly<Record<string, string>> = {
  received: 'Received',
  awaiting_stock: 'Awaiting stock',
  reserved: 'Reserved',
  in_wave: 'In wave',
  picking: 'Picking',
  picked: 'Picked',
  packed: 'Packed',
  shipped: 'Shipped',
  cancelled: 'Cancelled',
};

const COLOR: Readonly<Record<string, string>> = {
  awaiting_stock: 'var(--warn)',
  cancelled: 'var(--danger)',
  shipped: 'var(--ok)',
  packed: 'var(--ok)',
};

export const statusLabel = (s: string): string => STATUS_LABEL[s] ?? s;
export const statusColor = (s: string): string => COLOR[s] ?? 'var(--muted)';

/** Orders can be cancelled until they are packed (decision D-3). */
export const canCancel = (s: string): boolean => !['packed', 'shipped', 'cancelled'].includes(s);
