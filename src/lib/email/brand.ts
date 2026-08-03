// Single source of truth for every email's look. Change it here, all emails update.
// White editorial direction: white canvas, serif headings, the purple→magenta→orange
// logo gradient used sparingly as accent rules and the CTA button, never a colour flood.

export const brand = {
  color: {
    ink: '#1a1a1a',      // headings / strong text
    body: '#4a4a4a',     // body copy
    muted: '#8a8a8a',    // labels / meta
    line: '#ececec',     // hairlines
    soft: '#faf7fb',     // faint purple-tinted panel bg
    page: '#f4f1f5',     // outer page bg
    white: '#ffffff',
    purple: '#7a2d8e',
    magenta: '#c13c8a',
    orange: '#e0612a',
  },
  // Gmail strips background-image gradients, so anything using this MUST carry a
  // solid backgroundColor fallback. For guaranteed gradient we use the hosted strip image.
  gradient: 'linear-gradient(90deg, #6e2a8c 0%, #c13c8a 50%, #ee6b2d 100%)',
  gradientFallback: '#b5398a',
  font: {
    sans: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
    serif: 'Georgia, "Times New Roman", serif',
    mono: '"SF Mono", Menlo, Consolas, monospace',
  },
  url: {
    site: 'https://cthalaal.co.za',
    instagram: 'https://www.instagram.com/youngatheart_capetown/',
    facebook: 'https://www.facebook.com/globalcuisineco/',
    linkedin: 'https://www.linkedin.com/company/85941152',
    logo: 'https://cthalaal.co.za/email-logo.png',
    accent: 'https://cthalaal.co.za/email-accent.png',
  },
  contact: {
    email: 'support@youngatheart.co.za',
    phone: '+27 65 943 5012',
    venue: 'Youngsfield Military Base, corner of Wetton Road and Chucker Road, Cape Town',
    dates: '11-13 December 2026',
  },
} as const
