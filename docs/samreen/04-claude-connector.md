# 04. Use Claude to run your inbox, follow-ups and checks

> Setup takes 3 minutes. You do it once, on your own Claude account, and it works on the Claude website, the Claude desktop app and the Claude phone app.

## What you get

Your Claude can now:

- **Read and answer the inbox.** WhatsApp and email conversations, the same ones you see under Communications in the portal. Claude drafts, you say yes, it sends.
- **Chase vendors.** "Remind everyone approved in Fashion who has not uploaded documents." Claude shows you the list and the message first, then sends by WhatsApp or email.
- **Check things.** "How many applications are pending?", "What is the status of Table Art?", "Show me the dashboard numbers."
- **Understand payments.** "Who has paid?", "What does Elegant Muslimah still owe?", "Which EFT proofs are waiting for me?", "How much have we collected?" Claude reads the same Finance, Paid Vendors and EFT Proofs pages you use, and can confirm an EFT proof for you after you say yes.

It sees exactly what your portal login sees. Nothing more, nothing less. Every message it sends is recorded in the portal as sent by you.

## Step 1. Get your private link

Taona sends you one link that looks like this:

```
https://cthalaal.co.za/api/mcp/cth_xxxxxxxxxxxxxxxxxxxxxxxx.xxxxxxxxxxxxxxxxxxxxxxxx
```

**Treat this link like a password.** It is yours alone. Do not forward it, screenshot it, or paste it into a group. If it ever leaks, tell Taona and he issues a new one in one minute; the old one stops working.

## Step 2. Add it to Claude (once)

On the Claude website (claude.ai) or the desktop app:

1. Click your name (bottom left) then **Settings**.
2. Open **Connectors** (on some accounts it is under **Customize > Connectors**).
3. Click **+** or **Add custom connector**.
4. Name: `Festival admin`.
5. Remote MCP server URL: paste your private link.
6. Leave the Advanced / OAuth fields empty. Click **Add**.

That is it. The phone app picks it up on its own. You do not log in anywhere; the link is the login.

## Step 3. Turn it on in a chat

Start a new chat, click the **+** (or the tools / connectors icon) in the message box, and make sure **Festival admin** is switched on. Then talk normally.

## Things to try

- "What is waiting in my inbox?"
- "Open the conversation with 071 234 5678 and summarise it."
- "Reply to her: the stall numbers go out on Monday, thanks for your patience." (Claude shows the text, sends after you confirm.)
- "List pending applications in Food, oldest first."
- "Tell me everything about Elegant Muslimah."
- "Draft a WhatsApp reminder to approved vendors who have not signed the contract. Show me the list before sending."
- "What are the dashboard numbers today?"
- "Mark the thread with Amc cookware as done."

## Payments, in Claude's words

- **Paid** = money settled: a card payment through Yoco, or an EFT you confirmed.
- **Proof pending** = the vendor uploaded a proof of EFT and it is waiting for you to confirm. Ask "show me the proofs waiting" and Claude lists them with the reference, the amount and a link to the proof file.
- **Confirming a proof:** say "confirm the proof for Haadiya Bakes". Claude shows you the name, reference and amount, and only marks them paid after you say yes. That is the same as the Confirm button on the EFT Proofs page, and the vendor gets the payment-received message.
- **none / pending / deferred** = nothing received yet, or agreed to pay later.
- "How much have we collected" uses confirmed money only; proofs waiting are never counted.

## Rules Claude follows

- It **always shows you the message before it sends**, and for a group send it always previews the recipient list first.
- It cannot delete anything, and it never marks a vendor paid without showing you the proof details and getting your yes.
- It cannot approve or reject applications; do that in the portal as before.
- If it says "Vendor not found", the vendor is not in your portal view either.

## If something is off

- Claude says the connector failed to connect: the link is wrong or has been replaced. Ask Taona for a fresh one.
- A message did not arrive: check the conversation in the portal (Communications). Failed sends show there with a reason.
- You want it removed: Settings > Connectors > Festival admin > Remove. Also tell Taona so he retires the link.
