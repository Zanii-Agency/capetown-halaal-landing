/* eslint-disable @typescript-eslint/no-explicit-any */
export interface ToolRun {
    name: string;
    result: any;
}
export interface CompletionShape {
    /** Human-readable name for debugging (e.g. "money", "task", "case"). */
    name: string;
    /** Regex that detects this shape in the reply. */
    regex: RegExp;
    /** Tool names whose ok=true backing satisfies this shape. */
    requiredTools: ReadonlySet<string>;
    /** Tool names whose successful READ (no ok field, no error) also satisfies this shape. */
    readTools?: ReadonlySet<string>;
    /** True when a successful "parsed-task" write also satisfies this shape (workaround for cross-category title text). */
    parseTasksExempt?: boolean;
}
export interface CompletionGuardConfig {
    /** Detects an explicit agent claim of completion ("I logged", "I marked X done"). */
    agentCompletion: RegExp;
    /** Detects a shorthand "it's done" / "that's complete" with implicit agent prefix. */
    doneSimple: RegExp;
    /** Detects future/conditional phrasings that are NOT completion claims. */
    futureClaim: RegExp;
    /** Detects "you complete X" addresser-flipped phrasings that are NOT agent claims. */
    aboutUserComplete: RegExp;
    /** Detects "I did X" agent-self phrasings (used to disambiguate aboutUser overlaps). */
    agentSelfMark: RegExp;
    /** All tool names whose ok=true could back a generic done-claim. */
    completionTools: ReadonlySet<string>;
    /** Per-category shape detectors and their backing tool requirements. */
    shapes: ReadonlyArray<CompletionShape>;
    /** Optional predicate: returns true if a parsed-task write succeeded this turn. */
    parseTasksSucceeded?: (toolRuns: ReadonlyArray<ToolRun>) => boolean;
    /** Tool names whose successful read makes ANY shape exempt (e.g. list_tasks narration). */
    globalReadExemptTools?: ReadonlySet<string>;
}
/**
 * Build a (reply, toolRuns) → boolean guard from a per-tenant config.
 * Returns true when the reply asserts a completed action but no
 * category-matched completion-class tool returned ok=true this turn.
 */
export declare function makeCompletionGuard(config: CompletionGuardConfig): (reply: string, toolRuns: ReadonlyArray<ToolRun>) => boolean;
export interface SendGuardConfig {
    /** All "sent / told / notified / they have it" phrasings. */
    sendClaim: RegExp;
    /** Future/honest phrasings that are NOT claims of having sent. */
    futureOrHonest: RegExp;
    /** Tool names whose ok=true legitimately backs a "sent" claim. */
    sendTools: ReadonlySet<string>;
}
/**
 * Build a (reply, toolRuns) → boolean guard for "claimed to have sent a
 * message but no send-class tool succeeded." Mirrors makeCompletionGuard's
 * shape but simpler: there's only one category (send).
 */
export declare function makeSendGuard(config: SendGuardConfig): (reply: string, toolRuns: ReadonlyArray<ToolRun>) => boolean;
export interface StagingGuardConfig {
    /** "Ready to log / I'll stage / I have it staged / waiting for your yes" phrasings. */
    stagingClaim: RegExp;
    /** Tool names whose ok=true backs a "staged" claim (typically: record_payment, draft_email, ...). */
    stagingTools: ReadonlySet<string>;
}
/**
 * Build a (reply, toolRuns) → boolean guard for "claimed to have staged
 * something for later confirmation but never called the staging tool."
 */
export declare function makeStagingGuard(config: StagingGuardConfig): (reply: string, toolRuns: ReadonlyArray<ToolRun>) => boolean;
export interface SympathyGuardConfig {
    /** Regex that detects a sympathy opener at the START of a reply. */
    sympathyOpener: RegExp;
}
/**
 * Build a history → boolean check: was a sympathy opener already used in this
 * thread? Adapter calls strip if true to prevent "I'm so sorry, Nur" cascading.
 */
export declare function makeSympathyGuard(config: SympathyGuardConfig): (history?: ReadonlyArray<{
    role: string;
    content: string;
}>) => boolean;
//# sourceMappingURL=honesty-guards.d.ts.map