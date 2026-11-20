/**
 * The only code that puts a ChatGPT-plan request on the wire. It sits under
 * the AI SDK's Responses model as its `fetch`, and:
 *
 *  - accepts only `POST https://api.openai.com/v1/responses`;
 *  - checks the body against the preview's request rules and fails fast on
 *    anything Kodus is not supposed to send (only `max_output_tokens`, which
 *    Kodus sets on purpose, is removed);
 *  - asks the token source for a fresh access token per request;
 *  - turns the SDK's non-streaming generate call into a `stream: true`
 *    request, accumulates the SSE events, and requires `response.completed`;
 *  - answers the SDK with the completed response as ordinary JSON.
 *
 * Port of OpenCodeReview `internal/llm/responses_client.go`
 * (`CompletionsWithCtx`, `responseStreamAccumulator`) and `chatgpt.go`.
 */
import { APICallError, parseJsonEventStream } from 'ai';
import { z } from 'zod';
import { LlmErrorCategory } from '@libs/llm/error-classifier';
import { BodyTooLargeError, readBoundedText } from './bounded-body';
import {
    CHATGPT_RESPONSES_URL,
    KODUS_TOOL_NAMESPACE,
    MAX_OAUTH_BODY,
    MAX_STREAM_OUTPUT,
    STREAM_ITEM_OVERHEAD,
} from './constants';
import {
    siwcError,
    siwcHttpError,
    siwcStreamError,
    siwcTransportError,
} from './api-error';
import type { ChatGptTokenSource } from './token-source';

/** Body fields the preview rejects. Kodus never sets them, so their presence
 *  means a bug or an override that bypassed save-time validation. */
export const REJECTED_REQUEST_FIELDS = [
    'background',
    'conversation',
    'max_tool_calls',
    'metadata',
    'moderation',
    'multi_agent',
    'prompt',
    'prompt_cache_retention',
    'safety_identifier',
    'temperature',
    'top_logprobs',
    'top_p',
    'truncation',
    'user',
    'previous_response_id',
    'service_tier',
    'prompt_cache_options',
    'context_management',
] as const;

const TOOL_CHOICES = new Set(['auto', 'none', 'required']);

export interface SiwcFetchDeps {
    credentialId: string;
    /** Resolved per request, so a process wires its source after build. */
    tokenSource: () => ChatGptTokenSource;
    inner: typeof fetch;
}

function rejected(message: string): Error {
    return siwcError({
        message,
        url: CHATGPT_RESPONSES_URL,
        status: 400,
        retryable: false,
        category: LlmErrorCategory.REQUEST_REJECTED,
    });
}

const isObject = (v: unknown): v is Record<string, unknown> =>
    !!v && typeof v === 'object' && !Array.isArray(v);

/** Check the SDK's body against the preview rules; return the wire body. */
export function toPlanRequest(
    body: Record<string, unknown>,
): Record<string, unknown> {
    if (body.store !== false) {
        throw rejected('ChatGPT plan requests must set store: false');
    }
    if (
        !Array.isArray(body.include) ||
        !body.include.includes('reasoning.encrypted_content')
    ) {
        throw rejected(
            'ChatGPT plan requests must include reasoning.encrypted_content',
        );
    }
    for (const field of REJECTED_REQUEST_FIELDS) {
        if (field in body) {
            throw rejected(
                `ChatGPT plan requests do not accept the "${field}" field`,
            );
        }
    }
    if (!Array.isArray(body.input)) {
        throw rejected('ChatGPT plan requests need an input item list');
    }
    for (const item of body.input) {
        if (!isObject(item)) {
            throw rejected('ChatGPT plan input items must be objects');
        }
        if (
            (item.type === undefined || item.type === 'message') &&
            item.role === 'system'
        ) {
            throw rejected(
                'ChatGPT plan requests do not accept system message items; use the developer role',
            );
        }
        if (
            item.type === 'function_call' &&
            item.namespace !== KODUS_TOOL_NAMESPACE.name
        ) {
            throw rejected(
                'ChatGPT plan function calls must be replayed in the Kodus tool namespace',
            );
        }
    }
    if (body.tools !== undefined) {
        if (!Array.isArray(body.tools)) {
            throw rejected('ChatGPT plan tools must be a list');
        }
        for (const tool of body.tools) {
            if (
                !isObject(tool) ||
                tool.type !== 'namespace' ||
                tool.name !== KODUS_TOOL_NAMESPACE.name ||
                !Array.isArray(tool.tools) ||
                !tool.tools.every((t) => isObject(t) && t.type === 'function')
            ) {
                throw rejected(
                    'ChatGPT plan requests may only offer function tools inside the Kodus namespace',
                );
            }
        }
    }
    if (
        body.tool_choice !== undefined &&
        !TOOL_CHOICES.has(body.tool_choice as string)
    ) {
        throw rejected(
            'ChatGPT plan requests accept only auto, none or required as tool_choice',
        );
    }
    // Kodus caps output on purpose (slot cap, loop fallback, usage-meter
    // admission); the preview rejects the field, so it is the one removed.
    const { max_output_tokens: _dropped, ...rest } = body;
    return { ...rest, stream: true };
}

/** Wait for `promise`, or fail as soon as `signal` aborts. The promise keeps
 *  running: a token rotation the issuer already performed is persisted even
 *  when this caller has gone. */
function raceAbort<T>(
    promise: Promise<T>,
    signal?: AbortSignal | null,
): Promise<T> {
    if (!signal) return promise;
    if (signal.aborted) return Promise.reject(signal.reason);
    return new Promise<T>((resolve, reject) => {
        const onAbort = () => reject(signal.reason);
        signal.addEventListener('abort', onAbort, { once: true });
        promise.then(
            (v) => {
                signal.removeEventListener('abort', onAbort);
                resolve(v);
            },
            (e) => {
                signal.removeEventListener('abort', onAbort);
                reject(e);
            },
        );
    });
}

const eventSchema = z.looseObject({ type: z.string() });

interface StreamEvent {
    type: string;
    [key: string]: unknown;
}

/** Collect SSE events into the completed Responses object. */
export class ResponseStreamAccumulator {
    private items: Array<{ index: number; item: unknown }> = [];
    private outputBytes = 0;
    private terminal?: Record<string, unknown>;

    constructor(
        private readonly requestId: string,
        private readonly secrets: readonly string[],
    ) {}

    add(event: StreamEvent): void {
        switch (event.type) {
            case 'response.output_item.done': {
                const size =
                    Buffer.byteLength(JSON.stringify(event.item ?? null)) +
                    STREAM_ITEM_OVERHEAD;
                if (size > MAX_STREAM_OUTPUT - this.outputBytes) {
                    throw this.limitExceeded();
                }
                this.outputBytes += size;
                this.items.push({
                    index: Number(event.output_index ?? 0),
                    item: event.item,
                });
                return;
            }
            case 'response.completed': {
                const response = isObject(event.response) ? event.response : {};
                if (
                    Buffer.byteLength(JSON.stringify(response)) >
                    MAX_STREAM_OUTPUT - this.outputBytes
                ) {
                    throw this.limitExceeded();
                }
                this.terminal = response;
                return;
            }
            case 'response.failed':
            case 'response.incomplete': {
                const response = isObject(event.response) ? event.response : {};
                const error = isObject(response.error) ? response.error : {};
                throw siwcStreamError({
                    url: CHATGPT_RESPONSES_URL,
                    event: event.type,
                    code: str(error.code),
                    message: str(error.message),
                    param: str(error.param),
                    incompleteDetails: response.incomplete_details,
                    requestId: this.requestId,
                    secrets: this.secrets,
                });
            }
            case 'error':
                throw siwcStreamError({
                    url: CHATGPT_RESPONSES_URL,
                    event: 'error',
                    code: str(event.code),
                    message: str(event.message),
                    param: str(event.param),
                    requestId: this.requestId,
                    secrets: this.secrets,
                });
            default:
                return;
        }
    }

    /** The completed response. A terminal whose `output` is empty is rebuilt
     *  from the `output_item.done` events in index order. */
    response(): Record<string, unknown> {
        if (!this.terminal) {
            throw siwcError({
                message: 'ChatGPT stream ended before a terminal event',
                url: CHATGPT_RESPONSES_URL,
                status: 502,
                retryable: true,
                category: LlmErrorCategory.TRANSIENT,
            });
        }
        if (this.terminal.status !== 'completed') {
            throw siwcError({
                message: 'ChatGPT stream did not reach response.completed',
                url: CHATGPT_RESPONSES_URL,
                status: 502,
                retryable: false,
                category: LlmErrorCategory.TRANSIENT,
            });
        }
        if (
            Array.isArray(this.terminal.output) &&
            this.terminal.output.length > 0
        ) {
            return this.terminal;
        }
        const output = [...this.items]
            .sort((a, b) => a.index - b.index)
            .map((x) => x.item);
        return { ...this.terminal, output };
    }

    private limitExceeded(): Error {
        return siwcError({
            message:
                'ChatGPT stream failed: code=output_limit_exceeded output exceeds 16 MiB stream limit',
            url: CHATGPT_RESPONSES_URL,
            status: 400,
            retryable: false,
            category: LlmErrorCategory.REQUEST_REJECTED,
        });
    }
}

const str = (v: unknown): string | undefined =>
    typeof v === 'string' ? v : undefined;

function requestUrl(input: RequestInfo | URL): string {
    if (typeof input === 'string') return input;
    if (input instanceof URL) return input.href;
    return input.url;
}

/** Every function call the model returns must be in the namespace it was
 *  offered, or it is not a call Kodus made available. */
function assertNamespacedCalls(response: Record<string, unknown>): void {
    const output = Array.isArray(response.output) ? response.output : [];
    for (const item of output) {
        if (
            isObject(item) &&
            item.type === 'function_call' &&
            item.namespace !== KODUS_TOOL_NAMESPACE.name
        ) {
            throw rejected(
                'ChatGPT returned a function call outside the offered Kodus namespace',
            );
        }
    }
}

export function siwcFetch(deps: SiwcFetchDeps): typeof fetch {
    return async (input, init) => {
        const url = requestUrl(input);
        const method = (init?.method ?? 'GET').toUpperCase();
        if (url !== CHATGPT_RESPONSES_URL || method !== 'POST') {
            throw rejected(
                `ChatGPT plan requests may only POST ${CHATGPT_RESPONSES_URL}`,
            );
        }
        if (typeof init?.body !== 'string') {
            throw rejected('ChatGPT plan request body must be JSON text');
        }
        const parsed: unknown = JSON.parse(init.body);
        if (!isObject(parsed)) {
            throw rejected('ChatGPT plan request body must be a JSON object');
        }
        const wire = toPlanRequest(parsed);

        const token = await raceAbort(
            deps.tokenSource().accessToken(deps.credentialId),
            init.signal,
        );
        const secrets = [token];
        const headers = new Headers(init.headers);
        headers.set('Authorization', `Bearer ${token}`);
        headers.set('Content-Type', 'application/json');
        headers.set('Accept', 'text/event-stream');

        let response: Response;
        try {
            response = await deps.inner(url, {
                ...init,
                method: 'POST',
                headers,
                body: JSON.stringify(wire),
                redirect: 'manual',
            });
        } catch (err) {
            if (init.signal?.aborted) throw err;
            throw siwcTransportError(url, err);
        }

        const requestId = response.headers.get('x-request-id') ?? '';
        if (response.status < 200 || response.status >= 300) {
            let body: string | undefined;
            try {
                body = await readBoundedText(response, MAX_OAUTH_BODY);
            } catch (err) {
                if (!(err instanceof BodyTooLargeError)) {
                    throw siwcTransportError(url, err);
                }
            }
            throw siwcHttpError({
                url,
                status: response.status,
                headers: response.headers,
                body,
                secrets,
            });
        }
        if (!response.body) {
            throw siwcTransportError(url, new Error('empty response body'));
        }

        const accumulator = new ResponseStreamAccumulator(requestId, secrets);
        const reader = parseJsonEventStream({
            stream: response.body,
            schema: eventSchema,
        }).getReader();
        try {
            for (;;) {
                const { done, value } = await reader.read();
                if (done) break;
                if (value.success === false) {
                    throw siwcError({
                        message: `ChatGPT stream carried an invalid event: ${value.error.message}`,
                        url,
                        status: 502,
                        retryable: false,
                        category: LlmErrorCategory.TRANSIENT,
                    });
                }
                accumulator.add(value.value as StreamEvent);
            }
        } catch (err) {
            // Cleanup only: the original failure is the one reported.
            await reader.cancel().catch(() => undefined);
            if (init.signal?.aborted || APICallError.isInstance(err)) throw err;
            throw siwcTransportError(url, err);
        }
        const completed = accumulator.response();
        assertNamespacedCalls(completed);
        return new Response(JSON.stringify(completed), {
            status: 200,
            headers: {
                'content-type': 'application/json',
                ...(requestId ? { 'x-request-id': requestId } : {}),
            },
        });
    };
}
