'use client';

import { Suspense } from 'react';
import { AppShell } from '@/widgets/app-shell';
import { OrderDetail, OrdersList } from '@/widgets/orders-view';
import { ShopCatalog, ShopInbound } from '@/widgets/shop-catalog';
import { ShopStock } from '@/widgets/shop-stock';
import { Spinner } from '@/shared/ui';

const Page = ({ children }: { children: React.ReactNode }) => (
  <AppShell>
    <Suspense fallback={<Spinner />}>{children}</Suspense>
  </AppShell>
);

export const ShopStockPage = () => (
  <Page>
    <ShopStock />
  </Page>
);
export const ShopOrdersPage = () => (
  <Page>
    <OrdersList mode={{ kind: 'shop' }} base="/shop/orders" />
  </Page>
);
export const ShopOrderPage = ({ id }: { id: string }) => (
  <Page>
    <OrderDetail id={id} mode={{ kind: 'shop' }} />
  </Page>
);
export const ShopSkusPage = () => (
  <Page>
    <ShopCatalog />
  </Page>
);
export const ShopInboundPage = () => (
  <Page>
    <ShopInbound />
  </Page>
);
