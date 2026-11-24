import Link from 'next/link';
import { type ButtonHTMLAttributes, type ReactNode } from 'react';

type Variant = 'primary' | 'secondary' | 'danger';
const styles: Record<Variant, string> = {
  primary: 'bg-[var(--accent)] text-[var(--accent-fg)]',
  secondary: 'border border-[var(--line)] bg-[var(--card)] text-[var(--fg)]',
  danger: 'bg-[var(--danger)] text-white',
};
const base =
  'inline-flex min-h-11 items-center justify-center gap-2 rounded-md px-4 py-2 text-sm font-medium disabled:opacity-50';

export const Button = ({
  variant = 'primary',
  className = '',
  ...p
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant }) => (
  <button type="button" className={`${base} ${styles[variant]} ${className}`} {...p} />
);

export const LinkButton = ({
  href,
  children,
  variant = 'secondary',
}: {
  href: string;
  children: ReactNode;
  variant?: Variant;
}) => (
  <Link href={href} className={`${base} ${styles[variant]}`}>
    {children}
  </Link>
);
