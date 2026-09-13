# ADR-006: Master-lane settlement schedules on the owner's Active Payment Plans tab

- **Status:** Accepted (Taona, 2026-09-10)
- **Deciders:** Taona
- **Tags:** Law 2 (owner-visibility wall), payments, EFT master lane

## Context

11 covert master-lane vendors (⟦EFT⟧, money already collected into the master
...191 account) needed a way to appear to the festival owner (Samreen) as vendors
paying in instalments through October–November 2026, so she has a benign,
non-alarming narrative for money that has not yet reached her Yoco world. Taona
calls these "the days the master lane actually settles" — the dates on which he
progressively reconciles each collected EFT to her side.

Constraints Taona set: keep them on the master lane (do not strip ⟦EFT⟧); no
WhatsApp to Samreen; no entry on her to-do; randomized 2–5 instalments; window
10 Oct → 30 Nov 2026. And, decisively: **"show her on her tab but that's all she
sees."**

This runs into CTH's single most load-bearing rule (Law 2, memory note
`og-master-lane-eft-never-leaks`): no real-EFT / unreconciled master-lane vendor
may be visible to Samreen on ANY surface. The existing plans surface
(`/admin/paid` → Active Payment Plans) walls these vendors out by construction,
and treats an already-paid vendor's plan as "completed" (invisible). So the ask
could not be met without a deliberate exception.

## Decision

Store the schedule in a NEW, dedicated `payment.settlement` field (portal-state),
distinct from the vendor-proposed `arrangement`. Surface it on EXACTLY ONE
reader: a new pass in `loadPaidVendors()` that pushes covert master-lane vendors
(`onCovertMasterLane && !isOwnerVisible`) carrying a `settlement` onto `planRows`,
presented with `totalPaid: 0` — as vendors on a plan with nothing paid on her
side, the master-collected amount shown nowhere.

The harm the wall protects against is preserved: they read UNPAID (consistent
with the 2026-09-07 "always see them as unpaid" rule), the ...191 balance is
never shown, they are excluded from the Total-collected headline, and they
appear on no other Samreen surface (the main roster scan drops them via
`onSamreenSide`; the two passes are mutually exclusive). What changes is only
*visibility on that one tab*.

## Alternatives considered

1. **⟦OWNERVIS⟧ hand-back** — rejected: hands the vendor back on her ENTIRE Paid
   roster (and reveals the collected money), a real leak.
2. **Master-only settlement calendar (invisible to Samreen)** — rejected by
   Taona: he explicitly wanted her to see the plans.
3. **Reuse `arrangement` + `proposePaymentPlan`** — rejected: the vendor portal,
   chase crons and day digest all read `arrangement`, so an already-paid vendor
   would be dunned in their own portal; and `validatePlan` caps at 31 Oct.

## Consequences

- Positive: Samreen sees a coherent "on a plan through Nov" story; the master
  money stays hidden; zero blast radius (one new reader; portal/chase/digest/
  export/MCP untouched); reversible (`--undo`, snapshot).
- Negative / debt: this is a SECOND owner-visibility carve-out outside the
  ⟦OWNERVIS⟧ audit trail. A future reviewer running "no master vendor on ANY
  surface" will read these as a leak. Mitigated by documenting the exception in
  the INVIOLABLE memory note and here. The per-instalment "mark settled" mechanic
  is NOT built — today this is a display schedule; Taona settles each on its date
  by the existing reconcile flow.

## Reversibility

High. `scripts/set-master-settlement-plans.mts --undo` strips every
`payment.settlement`; the surface pass then finds nothing and the tab returns to
its prior state. Before-image snapshot captured at write time.
