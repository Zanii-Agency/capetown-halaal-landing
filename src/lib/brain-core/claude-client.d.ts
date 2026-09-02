/* eslint-disable @typescript-eslint/no-explicit-any */
export interface ClaudeCacheBlock {
    type: "text";
    text: string;
    cache_control?: {
        type: "ephemeral";
    };
}
export interface RunClaudeOpts {
    /** The model id, e.g. "claude-sonnet-4-5" or "claude-sonnet-4-6". */
    model: string;
    /** Adapter-supplied API key. Never read from env inside brain-core. */
    anthropicKey: string;
    /** System prompt: string or pre-split cache blocks (see splitForCache). */
    system: string | ClaudeCacheBlock[];
    /** The conversation messages. Anthropic format. */
    messages: any[];
    /** Tools the model may call. Anthropic tool schema. */
    tools: any[];
    /** Max output tokens (default 1400). */
    maxTokens?: number;
    /** Retry attempts on 429/529 (default 4). */
    maxAttempts?: number;
    /** Optional hook fired once all retries are exhausted with the final error. */
    onFailure?: (err: string) => void | Promise<void>;
    /** Optional eval-mode gym swap. brain-core calls gym.call(args) when gym.active() is true. */
    gym?: {
        active: () => boolean;
        call: (args: {
            model: string;
            max_tokens: number;
            system: string;
            tools: any[];
            messages: any[];
        }) => Promise<any>;
    };
}
/**
 * One Anthropic round-trip with caching + backoff + gym hook + failure hook.
 * Returns the raw Anthropic JSON response. Throws on terminal failure.
 *
 * The Adapter wraps the throw in its own error/retry/alert policy. brain-core
 * stays unopinionated about what to do when Claude is dead.
 */
export declare function runClaude(opts: RunClaudeOpts): Promise<any>;
//# sourceMappingURL=claude-client.d.ts.map