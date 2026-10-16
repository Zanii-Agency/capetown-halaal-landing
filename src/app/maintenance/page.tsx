import type { Metadata } from 'next'

export const metadata: Metadata = {
  title: 'Tune-up in progress · Cape Town Halaal Festival',
  description: 'We are doing a deep tune-up on the festival platform. Back shortly.',
  robots: { index: false, follow: false },
}

// No cache headers ensured by middleware + this dynamic flag.
export const dynamic = 'force-dynamic'
export const revalidate = 0

export default function MaintenancePage() {
  return (
    <main
      style={{
        minHeight: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: '#fafaf7',
        color: '#1a1a1a',
        padding: '2rem',
        fontFamily: 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
      }}
    >
      <div
        style={{
          maxWidth: 640,
          width: '100%',
          textAlign: 'center',
        }}
      >
        <div
          style={{
            display: 'inline-block',
            padding: '0.4rem 0.9rem',
            border: '1px solid #c89b3c',
            borderRadius: 999,
            fontSize: 12,
            letterSpacing: '0.18em',
            textTransform: 'uppercase',
            color: '#8a6915',
            marginBottom: '2rem',
            fontWeight: 500,
          }}
        >
          Tune-up in progress
        </div>

        <h1
          style={{
            fontFamily: '"Fraunces", Georgia, serif',
            fontSize: 'clamp(2rem, 5vw, 3.25rem)',
            lineHeight: 1.1,
            fontWeight: 400,
            margin: '0 0 1.25rem',
            color: '#0d0d0d',
          }}
        >
          We are polishing the festival platform.
        </h1>

        <p
          style={{
            fontSize: '1.1rem',
            lineHeight: 1.6,
            color: '#4a4a4a',
            maxWidth: 480,
            margin: '0 auto 2rem',
          }}
        >
          Back online shortly with everything tightened. Tickets for Young at
          Heart Festival 2026 are still available without interruption.
        </p>

        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: '0.75rem',
            alignItems: 'center',
          }}
        >
          <a
            href="https://tickets.youngatheart.co.za"
            style={{
              display: 'inline-block',
              padding: '0.85rem 1.75rem',
              background: '#cd2653',
              color: '#ffffff',
              borderRadius: 8,
              textDecoration: 'none',
              fontWeight: 500,
              fontSize: '0.95rem',
              letterSpacing: '0.02em',
            }}
          >
            Buy festival tickets
          </a>

          <a
            href="https://wa.me/27849644860"
            style={{
              fontSize: '0.95rem',
              color: '#1a1a1a',
              textDecoration: 'none',
              marginTop: '0.5rem',
              fontWeight: 500,
            }}
          >
            Need to make a payment? Contact +27 84 964 4860
          </a>

          <a
            href="mailto:support@youngatheart.co.za"
            style={{
              fontSize: '0.875rem',
              color: '#6a6a6a',
              textDecoration: 'none',
              marginTop: '0.5rem',
            }}
          >
            Urgent vendor or partner question? Email support@youngatheart.co.za
          </a>
        </div>

        <div
          style={{
            marginTop: '4rem',
            paddingTop: '2rem',
            borderTop: '1px solid #e5e5e0',
            fontSize: '0.75rem',
            color: '#9a9a9a',
            letterSpacing: '0.08em',
          }}
        >
          CAPE TOWN HALAAL · YOUNG AT HEART FESTIVAL 2026 · 11-13 DEC · YOUNGSFIELD MILITARY BASE
        </div>
      </div>
    </main>
  )
}
