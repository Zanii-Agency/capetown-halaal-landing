/**
 * Row predicates for the EFT lane table.
 *
 * WHY THIS IS A MODULE AND NOT A CONST IN THE COMPONENT. `isDemoRow` used to be
 * a `const` arrow declared inside EftAdminClient, BELOW the `sortedRows` sort
 * that calls it. `.sort()` runs its comparator synchronously during render, so
 * every render hit the temporal dead zone and threw
 *
 *     ReferenceError: Cannot access 'isDemo' before initialization
 *
 * which took the whole /admin/eft page down as "Application error: a client-side
 * exception has occurred" from 210aa38 (2026-07-27) until 2026-07-28.
 *
 * TypeScript never saw it. The call sits inside a callback, so tsc treats it as
 * deferred and `tsc --noEmit` passed clean the entire time. `npm run build`
 * passed too: the fault only exists at runtime, and only when the table holds
 * two or more rows (a one-row sort never invokes the comparator).
 *
 * An imported binding is initialised before the importing module body runs, so
 * declaration order in the component can never reintroduce this.
 */

/** The shape both predicates need. Deliberately narrower than the table's Row. */
export interface EftRowish {
  email: string | null
  business_name: string | null
}

/**
 * Seed and demo rows. They stay VISIBLE in the lane (Taona: "hide Sweet Treats
 * Demo and Demo Halal Kitchen from this list tho keep it on the list") but are
 * excluded from every total: R7,500 of fake vendor was sitting inside a R44,250
 * "Total owed" on a payments screen.
 */
export function isDemoRow(r: EftRowish): boolean {
  return /@cthalaal\.co\.za$/i.test(r.email || '') || /\bdemo\b/i.test(r.business_name || '')
}
