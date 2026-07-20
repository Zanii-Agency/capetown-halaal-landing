export type WebhookGuardAction = {
    action: "process";
} | {
    action: "skip";
    reason: string;
};
export type WebhookGuardAdapters = {
    seenByWamid: (wamid: string) => Promise<boolean>;
    logToChat: (sender: string, text: string) => Promise<void>;
    /** Optional cross-instance lock. Return false to skip (another instance is processing). */
    acquireLock?: (key: string, ttlMs: number) => Promise<boolean>;
};
export type WebhookGuardOpts = {
    /** True when the inbound message itself carries media (image/document/…).
     * Such a message must never be buffered as a text media-reference, or a
     * `merged_with_media` skip could drop the media row before it is logged. */
    hasMedia?: boolean;
};
export declare function shouldProcess(adapterName: string, sender: string, wamid: string | null | undefined, text: string | null | undefined, adapters: WebhookGuardAdapters, opts?: WebhookGuardOpts): Promise<WebhookGuardAction>;
export declare function mediaArrived(sender: string): string | null;
export declare function _resetForTest(): void;
//# sourceMappingURL=webhook-guard.d.ts.map