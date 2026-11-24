'use client';

import { useSyncExternalStore } from 'react';

type Toast = { readonly id: number; readonly kind: 'ok' | 'error'; readonly text: string };
const state: { items: readonly Toast[]; next: number } = { items: [], next: 1 };
const subs = new Set<() => void>();
const emit = () => subs.forEach((s) => s());

export const toast = (kind: Toast['kind'], text: string): void => {
  const id = state.next++;
  state.items = [...state.items, { id, kind, text }];
  emit();
  setTimeout(() => {
    state.items = state.items.filter((t) => t.id !== id);
    emit();
  }, 6000);
};

export const ToastHost = () => {
  const items = useSyncExternalStore(
    (cb) => (subs.add(cb), () => subs.delete(cb)),
    () => state.items,
    () => state.items,
  );
  return (
    <div
      className="fixed bottom-4 right-4 left-4 z-50 flex flex-col items-end gap-2 sm:left-auto"
      aria-live="polite"
    >
      {items.map((t) => (
        <div
          key={t.id}
          role={t.kind === 'error' ? 'alert' : 'status'}
          className={`rounded-md border bg-[var(--card)] px-3 py-2 text-sm shadow ${t.kind === 'error' ? 'border-[var(--danger)] text-[var(--danger)]' : 'border-[var(--ok)] text-[var(--ok)]'}`}
        >
          {t.text}
        </div>
      ))}
    </div>
  );
};
