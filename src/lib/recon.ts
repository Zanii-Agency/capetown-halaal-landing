// Recon view (2026-10-17, Taona): Samreen's new view. Her login sees the
// wrong-account payments and the bot-approved plans; the demo login keeps the
// pre-recon view, so this is gated by email, never by role.
// Pure, no server imports: the client sidebar uses it too.
export const RECON_EMAILS = new Set(['capetownhalaal@gmail.com', 'dev@cthalaal.co.za', 'taona@zanii.agency'])

export function canSeeRecon(email?: string | null): boolean {
  return !!email && RECON_EMAILS.has(email.trim().toLowerCase())
}
