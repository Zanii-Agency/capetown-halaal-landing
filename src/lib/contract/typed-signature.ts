// Render a typed full-name acceptance as a simple SVG image data URL, so the
// existing contract PDF renderer can treat it like a drawn signature.

export function typedSignatureDataUrl(name: string): string {
  const safe = String(name || '').replace(/[&<>"']/g, '')
  const width = 600
  const height = 120
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
    <rect width="100%" height="100%" fill="#ffffff"/>
    <text x="50%" y="55%" dominant-baseline="middle" text-anchor="middle"
      font-family="ui-serif, Georgia, 'Times New Roman', serif"
      font-size="36" fill="#1B1A17" font-style="italic">
      ${safe}
    </text>
  </svg>`
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`
}
