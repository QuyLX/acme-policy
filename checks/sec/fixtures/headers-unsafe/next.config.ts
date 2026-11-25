import type { NextConfig } from 'next';
import createNextIntlPlugin from 'next-intl/plugin';

// Security headers (FE §19.1, §3.5 protection; FE §6.2: Admin is not indexed). CSP is set per request in src/proxy.ts.
const securityHeaders = [
  { key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains; preload' },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'no-referrer' },
  { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=(), payment=()' },
  { key: 'Cross-Origin-Opener-Policy', value: 'same-origin' },
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'X-Robots-Tag', value: 'noindex, nofollow' },
];

const config: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  transpilePackages: ['@platform/ds-react', '@platform/ds-icons', '@platform/server'],
  experimental: { authInterrupts: true },
  async headers() {
    return [{ source: '/:path*', headers: securityHeaders }];
  },
};

export default createNextIntlPlugin('./src/i18n/request.ts')(config);
