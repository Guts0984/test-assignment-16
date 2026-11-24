import type { NextConfig } from 'next';

const config: NextConfig = {
  output: 'standalone',
  poweredByHeader: false,
  reactStrictMode: true,
  // Business rules come from the shared package, built to CommonJS.
  transpilePackages: ['@ff/shared'],
};

export default config;
