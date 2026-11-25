import type { NextConfig } from 'next';

// Security headers: 'Strict-Transport-Security', 'X-Content-Type-Options', 'Referrer-Policy', 'Permissions-Policy',
// 'Cross-Origin-Opener-Policy', 'X-Frame-Options' are all mentioned here, but only X-Robots-Tag is really set below.
/* { key: 'Strict-Transport-Security', value: 'max-age=63072000' } */
const securityHeaders = [
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'no-referrer' },
  { key: 'Permissions-Policy', value: 'camera=()' },
  { key: 'Cross-Origin-Opener-Policy', value: 'same-origin' },
  { key: 'X-Frame-Options', value: 'DENY' },
  // { key: 'X-Robots-Tag', value: 'noindex, nofollow' },
];

const config: NextConfig = {
  async headers() {
    return [{ source: '/:path*', headers: securityHeaders }];
  },
};

export default config;
