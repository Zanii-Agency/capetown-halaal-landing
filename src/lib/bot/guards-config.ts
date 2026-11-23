// CTH bot's BotGuardsConfig — v0.2 (defineBotConfig: frozen, precompiled,
// drop/strip pattern modes). This file is the SOURCE OF TRUTH for what the
// shared @zanii/bot-guards lib filters, classifies, and routes for
// THIS bot. The lib has zero knowledge of CTH; this config is what makes the
// lib behave like a CTH bot.
//
// v0.2 change that matters here: the em/en dash rule is now mode "strip".
// Under v0.1 a single stray dash replaced a whole correct answer with the
// reask phrase — a visitor asking gate times lost the entire reply to a
// style nit. Strip removes the dash and keeps the substance. Brand leaks and
// manipulation phrasing remain "drop": those replies deserve to die whole.
//
// Updating this file is the legitimate way to change CTH bot behavior at
// the lib boundary. DO NOT add bot-specific patterns to the lib itself.

import { defineBotConfig } from '../bot-guards/index.js'

export const CTH_BOT_GUARDS_CONFIG = defineBotConfig({
  botName: 'Cape Town Halaal Assistant',

  bannedPatterns: [
    // No-em-dashes law: STRIP the dash, keep the answer.
    { pattern: /[—–]/, mode: 'strip' as const, label: 'em_or_en_dash' },
    // Deploy-target law (CTH is Vercel): a Netlify mention is leaked
    // implementation detail — drop the reply.
    { pattern: /\bnetlify\b/i, mode: 'drop' as const, label: 'netlify_mention' },
    // Anti-manipulation: urgency pressure phrasing dies whole.
    { pattern: /\b(?:limited time|act now|only \d+ left|hurry up)\b/i, mode: 'drop' as const, label: 'negative_urgency' },
  ],

  // Brand names that MUST NEVER appear in CTH bot output. Includes:
  //  - Other Sinanagency bots (Sasa, Nisria, Jensen, Stephen)
  //  - The historical 4Q-framework leak vocabulary
  //  - Internal infra mentions
  forbiddenBrands: [
    'Sasa',
    'Nisria',
    'Jensen',
    'Stephen',
    '4Q framework',
    'Canada Made',
    'Sinan Agency',
    'sinanagency',
  ],

  intentEnum: [
    // CTH-specific intents — chosen by surveying admin-chat.ts + handover.ts
    'ticket_lookup',          // "where's my ticket?", "I bought 3 tickets"
    'vendor_status',          // "is my stall confirmed?", "what's my stall code?"
    'vendor_application_q',   // questions about the application process
    'event_info',             // "what time does the festival open?", "where is it?"
    'human_handover_request', // "talk to a human", "speak to someone"
    'opt_out',                // STOP keyword family
    'opt_in',                 // START / yes keyword family
    'admin_command',          // master-admin commands (handled by admin-chat.ts)
    'open_conversation',      // fallback — anything else, send to festival brain LLM
  ],

  pendingKinds: ['vendor_clarifying', 'ticket_clarifying'],

  reaskPhrase: 'Can you share a bit more so I can help with that?',

  anthropicApiKey: process.env.ANTHROPIC_API_KEY || '',
})
