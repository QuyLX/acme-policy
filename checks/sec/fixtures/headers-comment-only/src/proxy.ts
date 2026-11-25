// TODO: set the Content-Security-Policy header here with `frame-ancestors 'none'`, object-src 'none', base-uri 'none'
// and a per-request 'nonce-...' once the CSP is designed. Never use 'unsafe-inline'.
import { NextResponse, type NextRequest } from 'next/server';

/* response.headers.set('Content-Security-Policy', "frame-ancestors 'none'; 'nonce-abc'"); */
export function proxy(request: NextRequest) {
  return NextResponse.next({ request });
}
