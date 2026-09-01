# WhatsApp Templates for YAH Festival 2026

Status of each template + the exact wording submitted to Meta. Both are
**UTILITY** category (transactional), English.

## 1. `vendor_application_approved`

Fires when an admin approves a vendor application.

**Header:** (none)

**Body:**

```
Hi {{1}}, great news. Your application for {{2}} at Young at Heart Festival 2026 is approved.

Log in to your exhibitor portal at https://cthalaal.co.za/exhibitor/login using the temporary password we just emailed to you. Complete your details and upload your halaal certificate before {{3}}.

We can't wait to host you in December. The YAH Team.
```

**Footer:** (none)

**Buttons:** (none — keep it simple for first approval)

**Parameters:**
- {{1}} = vendor contact first name
- {{2}} = business name
- {{3}} = payment due date (e.g. "1 September 2026")

**Sample (Samreen example):**
> Hi Samreen, great news. Your application for Samreen Test Stall at Young at Heart Festival 2026 is approved.
>
> Log in to your exhibitor portal at https://cthalaal.co.za/exhibitor/login using the temporary password we just emailed to you. Complete your details and upload your halaal certificate before 1 September 2026.
>
> We can't wait to host you in December. The YAH Team.

---

## 2. `vendor_payment_confirmation`

Fires when a vendor's payment is confirmed (Yoco webhook or admin manual).
Already wired in `src/lib/payments/confirm.ts` and will fire automatically as
soon as the template is approved at Meta.

**Body:**

```
Hi {{1}}, payment received. {{2}} confirmed for {{3}} at Young at Heart Festival 2026.

Your invoice and stall details are in your portal at https://cthalaal.co.za/exhibitor/portal/invoice. See you in December. The YAH Team.
```

**Parameters:**
- {{1}} = vendor first name
- {{2}} = amount (e.g. "R6 500")
- {{3}} = stall label (e.g. "MARQUEE Full Space 3x3m")

**Sample (Samreen R10 example):**
> Hi Samreen, payment received. R10 confirmed for MARQUEE Full Space 3x3m at Young at Heart Festival 2026.
>
> Your invoice and stall details are in your portal at https://cthalaal.co.za/exhibitor/portal/invoice. See you in December. The YAH Team.

---

## 3. `paid_vendor_update`

Flexible two-way message to a paid vendor about their confirmed stall. Sent to
the `paid=true` audience (Yoco / master-EFT / cash / waived / Samreen). UTILITY,
so it is NOT marketing-capped like `general_announcement`. Invites a reply.

**Body:**

```
Hi {{1}}, a message from Young at Heart Festival 2026 about your confirmed stall:

{{2}}

You can reply here on WhatsApp if you have any questions. The YAH Team.
```

**Parameters:**
- {{1}} = vendor first name
- {{2}} = your message (single flowing line; raw newlines are stripped before send)

**Sample (Samreen example):**
> Hi Samreen, a message from Young at Heart Festival 2026 about your confirmed stall:
>
> Setup opens Thursday 10 December from 09:00. Please bring your vehicle pass and stall confirmation.
>
> You can reply here on WhatsApp if you have any questions. The YAH Team.

---

## 4. `paid_vendor_action_required`

Ask a paid vendor to do one thing for their confirmed stall. UTILITY. Invites a
reply and points to the portal as a secondary path.

**Body:**

```
Hi {{1}}, one thing needs your attention for your confirmed stall at Young at Heart Festival 2026:

{{2}}

Reply here on WhatsApp and we will help, or complete it in your portal: https://cthalaal.co.za/exhibitor/portal. The YAH Team.
```

**Parameters:**
- {{1}} = vendor first name
- {{2}} = the action needed (single flowing line; raw newlines are stripped before send)

**Sample (Samreen example):**
> Hi Samreen, one thing needs your attention for your confirmed stall at Young at Heart Festival 2026:
>
> Upload your logo so you appear in the public listings.
>
> Reply here on WhatsApp and we will help, or complete it in your portal: https://cthalaal.co.za/exhibitor/portal. The YAH Team.

---

## 5. `paid_vendor_question`

Ask a paid vendor a question and collect their answer by reply. UTILITY.

**Body:**

```
Hi {{1}}, a quick question about your confirmed stall at Young at Heart Festival 2026:

{{2}}

Just reply here on WhatsApp with your answer. Thank you. The YAH Team.
```

**Parameters:**
- {{1}} = vendor first name
- {{2}} = your question (single flowing line; raw newlines are stripped before send)

**Sample (Samreen example):**
> Hi Samreen, a quick question about your confirmed stall at Young at Heart Festival 2026:
>
> What time will your team arrive on setup day?
>
> Just reply here on WhatsApp with your answer. Thank you. The YAH Team.

---

## 6. `paid_vendor_setup_details`

Setup-day logistics for a paid vendor's confirmed stall. UTILITY. Invites a reply.

**Body:**

```
Hi {{1}}, setup details for your confirmed stall at Young at Heart Festival 2026:

{{2}}

Bring your vehicle pass and stall confirmation on the day. Reply here on WhatsApp if anything is unclear. The YAH Team.
```

**Parameters:**
- {{1}} = vendor first name
- {{2}} = the setup details (single flowing line; raw newlines are stripped before send)

---

## 7. `paid_vendor_schedule_update`

A timing or schedule change for a paid vendor's confirmed stall. UTILITY.

**Body:**

```
Hi {{1}}, an update to the schedule for your confirmed stall at Young at Heart Festival 2026:

{{2}}

Please note the change. Reply here on WhatsApp if this affects your plans. The YAH Team.
```

**Parameters:**
- {{1}} = vendor first name
- {{2}} = the schedule change (single flowing line; raw newlines are stripped before send)

---

## 8. `paid_vendor_reminder`

A friendly reminder to a paid vendor about their confirmed stall. UTILITY.

**Body:**

```
Hi {{1}}, a friendly reminder for your confirmed stall at Young at Heart Festival 2026:

{{2}}

Reply here on WhatsApp if you need a hand. The YAH Team.
```

**Parameters:**
- {{1}} = vendor first name
- {{2}} = the reminder (single flowing line; raw newlines are stripped before send)

---

## 9. `paid_vendor_good_news`

A positive update or welcome note to a paid vendor about their confirmed stall.
Submitted as UTILITY but **Meta approved it as MARKETING** (2026-09-02): the
positive/welcome register reads promotional. It is therefore subject to the
131049 marketing cap and can under-deliver, like `festival_announcement` did.
Kept by operator decision. For guaranteed delivery, use `paid_vendor_update`.

**Body:**

```
Hi {{1}}, good news about your confirmed stall at Young at Heart Festival 2026:

{{2}}

We are glad to have you with us. Reply here on WhatsApp anytime. The YAH Team.
```

**Parameters:**
- {{1}} = vendor first name
- {{2}} = the good news (single flowing line; raw newlines are stripped before send)

---

## How to submit to Meta

### Option A: Auto-submit via Graph API (fastest)

```
node scripts/submit-whatsapp-template.mjs vendor_application_approved
node scripts/submit-whatsapp-template.mjs vendor_payment_confirmation
node scripts/submit-whatsapp-template.mjs paid_vendor_update
node scripts/submit-whatsapp-template.mjs paid_vendor_action_required
node scripts/submit-whatsapp-template.mjs paid_vendor_question
node scripts/submit-whatsapp-template.mjs paid_vendor_setup_details
node scripts/submit-whatsapp-template.mjs paid_vendor_schedule_update
node scripts/submit-whatsapp-template.mjs paid_vendor_reminder
node scripts/submit-whatsapp-template.mjs paid_vendor_good_news
```

Reads template content from this file, posts to `https://graph.facebook.com/v20.0/{WHATSAPP_BUSINESS_ID}/message_templates`. Returns Meta's submission ID. Approval typically takes 5-60 minutes.

### Option B: Submit manually via Business Manager UI

1. Open https://business.facebook.com → WhatsApp Manager
2. Select "Cape Town Halaal" account
3. Templates → Create Template
4. Category: **UTILITY**
5. Language: **English**
6. Paste the body verbatim
7. Submit

---

## Status checks

```
node scripts/list-whatsapp-templates.mjs
```

Lists every template registered to your WABA with approval state (APPROVED / PENDING / REJECTED).

## Important

- Templates with the same name cannot be re-submitted while pending. Delete first if you want to change wording.
- Once APPROVED, the code at `src/lib/payments/confirm.ts` (payment) and `src/app/api/applications/[id]/route.ts` (approval) will fire them automatically.
- The 24-hour customer-service window does NOT apply to templates (templates are business-initiated, always sendable).
