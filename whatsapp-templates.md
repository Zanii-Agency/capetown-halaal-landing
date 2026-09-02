# WhatsApp Message Templates — for Meta submission

> Submit these in Meta Business Manager → WhatsApp Manager → Message Templates.
> Each needs approval (~1–2 days). Variables are `{{n}}`. Language: English (en).
> Event reminders for purchased tickets classify as **Utility**. Promo blasts = **Marketing**.

---

## 1. `ticket_delivery` — Utility
**Header:** Document (the QR ticket PDF) or Image (QR PNG)
**Body:**
```
Hi {{1}}! 🎟️ Your Young at Heart Festival tickets are confirmed.

Order {{2}}: {{3}}
📅 11–13 December 2026
📍 Youngsfield Military Base, Wetton Rd, Claremont

Your QR ticket is attached — show it at the gate. See you there!
Reply HELP for parking, schedule, or to re-send your ticket.
```
**Variables:** 1=first name, 2=order number, 3=ticket summary (e.g. "2× Weekend Pass")

---

## 2. `countdown_30day` — Utility
**Body:**
```
{{1}}, the Young at Heart Festival is 30 days away! 🎉

3 days of 350+ vendors, halaal food court, live entertainment & a kids zone — 11–13 Dec at Youngsfield.

Got your tickets? You're set. Need more for family? tickets.youngatheart.co.za
```
**Variables:** 1=first name

---

## 3. `countdown_1week` — Utility
**Body:**
```
One week to go, {{1}}! 🗓️ Young at Heart Festival, 11–13 December.

Plan ahead:
🚗 Parking on-site — arrive early
🕌 Prayer facilities available
🍽️ 50+ halaal food vendors
☀️ Cape Town summer — bring sunscreen & water

Full info & directions: reply HELP.
```
**Variables:** 1=first name

---

## 4. `countdown_daybefore` — Utility
**Body:**
```
{{1}}, it's tomorrow! 🎊 Gates open {{2}}.

📍 Youngsfield Military Base, Wetton Rd, Claremont
🎟️ Have your QR ticket ready (reply TICKET to re-send)
🚗 Free parking on-site — come early to beat the queue

See you at Young at Heart!
```
**Variables:** 1=first name, 2=gate open time (e.g. "9am")

---

## 5. `vendor_accepted` — Utility
**Body:**
```
Congratulations {{1}}! 🎉 Your booth application for the Young at Heart Festival is APPROVED.

Booth: {{2}}
Next step: log in to your vendor portal to confirm details, upload your halaal certificate, and view load-in times.

{{3}}
```
**Variables:** 1=business/contact name, 2=booth number, 3=portal login URL

---

## 6. `vendor_announcement` — Utility
**Body:**
```
📢 Young at Heart Festival — vendor update

{{1}}

Questions? Reply here or check your vendor portal.
```
**Variables:** 1=announcement body (admin-composed)

---

## 7. `vendor_setup_reminder` — Utility
**Body:**
```
{{1}}, setup reminder for Young at Heart Festival.

Booth: {{2}}
Load-in: {{3}}
Gate code: {{4}}

Bring your vehicle pass. Power & water as per your portal. See you on-site!
```
**Variables:** 1=name, 2=booth number, 3=load-in time, 4=gate code

---

## 8. `vendor_payment_reminder` — Utility (APPROVED in Meta)
**Body:**
```
Hi {{1}}, a friendly reminder that your stall fee for the Young at Heart Festival is due.

Amount: {{2}}
Due date: {{3}}

Your stall is only secured once payment is received in full. Please reply here if you have any questions.
```
**Variables:** 1=contact first name, 2=amount (e.g. "R6,500"), 3=due date (e.g. "22 July 2026")
**Sent by:** weekly cron `/api/cron/payment-reminders` (Mon 07:00 UTC) alongside the `VendorPaymentReminder` email, to approved vendors who have not paid.

---

## Keyword auto-replies (free-form, inside 24h window — no template needed)
| Keyword | Action |
|---|---|
| `HELP` | Hand to AI concierge (`api/chat` prompt) |
| `TICKET` | Look up order by phone, re-send QR |
| `STOP` | Set `whatsapp_opt_out`, confirm unsubscribe |
| anything else | AI concierge answers (parking, schedule, accommodation, directions) |

---

## `admin_alert` (UTILITY, en) — internal, admins only
**Body:** "Hi {{1}}, an item on the Young at Heart Festival admin desk needs your attention:\n\n{{2}}\n\nOpen the admin inbox to action it."
**Variables:** 1=admin first name, 2=the alert, flattened to one line (`flattenForTemplate`, max 1000 chars).
**Sent by:** `sendToAdmin` in `src/lib/bot/notify.ts` whenever an admin's 24h service window is shut: owner/master alerts (`notifyOwners`), the email-concierge bubbles, and the master mirror. Replaces `festival_announcement` (MARKETING) on that path: Meta's per-user marketing cap (error 131049) rejected ~100% of master alerts in Aug 2026. Created 2026-09-02, Meta id 1596202538520810.
