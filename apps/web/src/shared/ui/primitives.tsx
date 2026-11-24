import { type ReactNode } from 'react';

export const Card = ({
  title,
  children,
  actions,
}: {
  title?: string;
  children: ReactNode;
  actions?: ReactNode;
}) => (
  <section className="rounded-lg border border-[var(--line)] bg-[var(--card)] p-4">
    {(title !== undefined || actions !== undefined) && (
      <header className="mb-3 flex flex-wrap items-center justify-between gap-2">
        {title !== undefined && <h2 className="text-base font-semibold">{title}</h2>}
        {actions}
      </header>
    )}
    {children}
  </section>
);

const tone = {
  error: 'border-[var(--danger)] text-[var(--danger)]',
  ok: 'border-[var(--ok)] text-[var(--ok)]',
  info: 'border-[var(--line)] text-[var(--muted)]',
};

/** aria-live so scanner errors are announced; role=alert for errors. */
export const Banner = ({ kind = 'info', children }: { kind?: keyof typeof tone; children: ReactNode }) => (
  <div
    role={kind === 'error' ? 'alert' : 'status'}
    aria-live={kind === 'error' ? 'assertive' : 'polite'}
    className={`rounded-md border px-3 py-2 text-sm ${tone[kind]}`}
  >
    {children}
  </div>
);

export const Badge = ({ children, color = 'var(--muted)' }: { children: ReactNode; color?: string }) => (
  <span
    className="inline-block rounded-full border px-2 py-0.5 text-xs"
    style={{ borderColor: color, color }}
  >
    {children}
  </span>
);

export const Spinner = () => (
  <span role="status" aria-label="Loading" className="text-sm text-[var(--muted)]">
    Loading...
  </span>
);

export const EmptyState = ({ children }: { children: ReactNode }) => (
  <p className="py-6 text-center text-sm text-[var(--muted)]">{children}</p>
);
