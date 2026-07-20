import OutsideRoster from './OutsideRoster'

export const dynamic = 'force-dynamic'

// Outside Vendors roster. The 65 non-marquee vendors (bedouin + truck zones)
// that don't get a floor-plan stall. The client component fetches from
// /api/admin/outside (the auth gate: 401 -> /admin/login), mirroring the
// allocation + finance pages.
export default function OutsideVendorsPage() {
  return <OutsideRoster />
}
