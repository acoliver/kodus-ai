/**
 * The reasoning overrides a ChatGPT-plan model may carry. They become the
 * `openai` provider options, and the preview accepts only `reasoning`, `text`
 * and `prompt_cache_key` from them (OpenCodeReview `validateChatGPTBody`):
 * anything else would either be refused by OpenAI or, like `store`, break a
 * rule the transport enforces. Checked when the BYOK config is saved.
 */
export const CHATGPT_OVERRIDE_KEYS = [
    'reasoningEffort',
    // The vendor's wire spelling; `reasoningEffortFromWire` renames it.
    'reasoning_effort',
    'reasoningSummary',
    'textVerbosity',
    'promptCacheKey',
] as const;

const ALLOWED = new Set<string>(CHATGPT_OVERRIDE_KEYS);

/** The keys of a pasted override (under `openai` or bare) that are not
 *  allowed. An empty or absent override has none. Unparsable JSON is the
 *  generic save check's to report. */
export function reasoningOverrideOf(raw: unknown): { rejectedKeys: string[] } {
    if (typeof raw !== 'string' || !raw.trim()) return { rejectedKeys: [] };
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch {
        return { rejectedKeys: [] };
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return { rejectedKeys: [] };
    }
    const top = parsed as Record<string, unknown>;
    const keys = Object.keys(top);
    const options =
        keys.length === 1 &&
        keys[0] === 'openai' &&
        top.openai &&
        typeof top.openai === 'object' &&
        !Array.isArray(top.openai)
            ? (top.openai as Record<string, unknown>)
            : top;
    return {
        rejectedKeys: Object.keys(options).filter((k) => !ALLOWED.has(k)),
    };
}
