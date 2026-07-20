import { buildBadgeHtml } from '../src/lib/badges/badge-pdf'
import QRCode from 'qrcode'
import { writeFileSync } from 'fs'
const qr = await QRCode.toDataURL(String(9496), { margin: 1, width: 512 })
const html = buildBadgeHtml({
  name: 'Taona Mvakacha', role: 'manager', businessName: 'Zanii Agency (Demo)',
  stall: 'DEMO-A1', phone: '+27500000000', vehicleReg: 'ZANII 01', wcOrderId: 9496,
}, qr)
writeFileSync('/private/tmp/claude-501/-Users-milaaj/80039d07-51a3-41d2-aaa0-7db3b0919c86/scratchpad/badge-9496.html', html)
console.log('html written')
