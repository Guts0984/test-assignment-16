import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { Providers } from '@/app';
import '../src/app/globals.css';

export const metadata: Metadata = {
  title: 'Fulfillment',
  description: 'Warehouse fulfillment for online shops',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
