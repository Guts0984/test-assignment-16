'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { type ReactNode, useEffect } from 'react';
import { hasRole, isAdmin, isShop, useSession, warehousesWith } from '@/entities/session';
import { useMyWarehouses } from '@/entities/warehouse';
import { Button, Spinner } from '@/shared/ui';

type NavItem = { readonly href: string; readonly label: string };

const navFor = (
  me: NonNullable<ReturnType<typeof useSession>['me']>,
  warehouseId: string | null,
): NavItem[] => {
  if (isShop(me)) {
    return [
      { href: '/shop/stock', label: 'Stock' },
      { href: '/shop/orders', label: 'Orders' },
      { href: '/shop/skus', label: 'Products' },
      { href: '/shop/inbound', label: 'Inbound' },
    ];
  }
  const w = warehouseId;
  const items: NavItem[] = [];
  if (w !== null && hasRole(me, ['shift_lead']))
    items.push(
      { href: `/w/${w}/dashboard`, label: 'Shift' },
      { href: `/w/${w}/counts`, label: 'Counts' },
      { href: `/w/${w}/report`, label: 'Report' },
      { href: `/w/${w}/orders`, label: 'Orders' },
    );
  if (w !== null && hasRole(me, ['picker'])) items.push({ href: `/w/${w}/picker`, label: 'Pick' });
  if (w !== null && hasRole(me, ['packer', 'shift_lead']))
    items.push({ href: `/w/${w}/packer`, label: 'Pack' });
  if (w !== null && hasRole(me, ['storekeeper', 'shift_lead']))
    items.push(
      { href: `/w/${w}/receiving`, label: 'Receive' },
      { href: `/w/${w}/putaway`, label: 'Putaway' },
      { href: `/w/${w}/moves`, label: 'Moves' },
    );
  if (isAdmin(me))
    items.push(
      { href: '/admin/warehouses', label: 'Warehouses' },
      { href: '/admin/shops', label: 'Shops' },
      { href: '/admin/staff', label: 'Staff' },
      { href: '/admin/jobs', label: 'Failed jobs' },
    );
  return items;
};

/** Signs the user in (redirects to /login otherwise) and shows navigation for what their roles allow. */
export const AppShell = ({
  warehouseId,
  children,
}: {
  warehouseId?: string | undefined;
  children: ReactNode;
}) => {
  const { status, me, logout } = useSession();
  const router = useRouter();
  const warehouses = useMyWarehouses();
  useEffect(() => {
    if (status === 'anonymous') router.replace('/login');
  }, [status, router]);
  if (status !== 'authenticated' || me === null)
    return (
      <main className="p-6">
        <Spinner />
      </main>
    );
  const own = warehousesWith(me, ['shift_lead', 'storekeeper', 'picker', 'packer']);
  const current = warehouseId ?? own[0] ?? null;
  const nav = navFor(me, current);
  return (
    <div className="mx-auto flex min-h-screen max-w-6xl flex-col gap-4 px-4 py-4">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-[var(--line)] pb-3">
        <nav aria-label="Main" className="flex flex-wrap gap-1">
          {nav.map((n) => (
            <Link key={n.href} href={n.href} className="rounded-md px-3 py-2 text-sm hover:bg-[var(--card)]">
              {n.label}
            </Link>
          ))}
        </nav>
        <div className="flex items-center gap-3 text-sm">
          {!isShop(me) && own.length > 1 && (
            <select
              aria-label="Warehouse"
              className="min-h-11 rounded-md border border-[var(--line)] bg-[var(--card)] px-2"
              value={current ?? ''}
              onChange={(e) =>
                router.push(`/w/${e.target.value}/${hasRole(me, ['shift_lead']) ? 'dashboard' : 'receiving'}`)
              }
            >
              {own.map((id) => (
                <option key={id} value={id}>
                  {warehouses.data?.items.find((w) => w.id === id)?.code ?? id.slice(0, 8)}
                </option>
              ))}
            </select>
          )}
          <span className="text-[var(--muted)]">
            {me.name ?? me.email ?? (me.kind === 'api_key' ? 'API key' : 'Shop')}
          </span>
          <Button variant="secondary" onClick={() => void logout().then(() => router.replace('/login'))}>
            Sign out
          </Button>
        </div>
      </header>
      <main className="flex flex-1 flex-col gap-4">{children}</main>
    </div>
  );
};
