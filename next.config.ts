import type { NextConfig } from "next";

// Security headers applied to ALL routes. HSTS preload requires HTTPS-only
// delivery (Vercel terminates TLS). Permissions-Policy locks down camera,
// microphone, geolocation since this site never needs them. Frame-deny + nosniff
// + strict-origin-when-cross-origin are the OWASP baseline.
const securityHeaders = [
  {
    key: 'Strict-Transport-Security',
    value: 'max-age=63072000; includeSubDomains; preload',
  },
  {
    key: 'X-Content-Type-Options',
    value: 'nosniff',
  },
  {
    key: 'Referrer-Policy',
    value: 'strict-origin-when-cross-origin',
  },
  {
    key: 'Permissions-Policy',
    value: 'camera=(), microphone=(), geolocation=()',
  },
  {
    key: 'X-Frame-Options',
    value: 'DENY',
  },
  // CSP shipped in Report-Only mode first so prod doesn't break on a missed
  // origin. Browser logs violations, page still renders. Promote to the
  // enforcing header (`Content-Security-Policy`) after a clean sprint of
  // violation reports. connect-src covers: self, Supabase REST/Realtime,
  // Anthropic API, Resend webhook origins, Vercel telemetry. img-src 'self'
  // + data: + Unsplash (mirrors next.config remotePatterns). frame-ancestors
  // 'none' double-locks X-Frame-Options.
  {
    key: 'Content-Security-Policy-Report-Only',
    value: [
      "default-src 'self'",
      "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://va.vercel-scripts.com",
      "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
      "font-src 'self' data: https://fonts.gstatic.com",
      "img-src 'self' data: blob: https://images.unsplash.com https://*.supabase.co",
      "connect-src 'self' https://*.supabase.co wss://*.supabase.co https://api.anthropic.com https://api.resend.com https://vitals.vercel-insights.com",
      "frame-ancestors 'none'",
      "base-uri 'self'",
      "form-action 'self'",
      "object-src 'none'",
    ].join('; '),
  },
];

const nextConfig: NextConfig = {
  images: {
    remotePatterns: [
      {
        protocol: 'https',
        hostname: 'images.unsplash.com',
      },
    ],
    // Trimmed from the Next default ladder, which also includes 2048 and 3840.
    // Nothing on this site renders wider than a 1920 viewport, so those two
    // only ever served crawlers requesting arbitrary widths. Each entry here
    // is a distinct billable transform and a distinct CDN cache key.
    deviceSizes: [640, 750, 828, 1080, 1200, 1920],
    // Small fixed-width slots (partner logos, avatars) resolve from this list.
    imageSizes: [16, 32, 48, 64, 96, 128, 144, 256, 384],
    // Default is 60 seconds, which makes the optimizer re-fetch and re-encode
    // constantly under crawler load. 31 days. Source images are static assets
    // that change only on deploy.
    minimumCacheTTL: 2678400,
  },
  async headers() {
    return [
      {
        source: '/:path*',
        headers: securityHeaders,
      },
      {
        // Static media in public/ ships with Next's default
        // `max-age=0, must-revalidate`, so browsers revalidate every asset on
        // every page load. Unlike /_next/static these filenames are not
        // content hashed, so `immutable` would strand a replaced photo. One
        // day fresh plus a week of stale-while-revalidate is the safe middle:
        // repeat visitors stop re-requesting, and a swapped image still
        // propagates within a day.
        source: '/:dir(photos|gallery|partners|about|videos)/:file*',
        headers: [
          {
            key: 'Cache-Control',
            value: 'public, max-age=86400, stale-while-revalidate=604800',
          },
        ],
      },
    ];
  },
  async redirects() {
    // Legacy static portal page is gone, send any old link to the real login.
    return [
      { source: '/exhibitor.html', destination: '/exhibitor/login', permanent: true },
      // Legacy vendor-ops workspace was renamed to allocation. 301 so any
      // bookmarks/links in older docs/emails land on the live map. The
      // vendor-ops page files remain on disk for one sprint as a safety net.
      { source: '/admin/vendor-ops', destination: '/admin/allocation', permanent: true },
      { source: '/admin/vendor-ops/:path*', destination: '/admin/allocation', permanent: true },
    ];
  },
};

export default nextConfig;
