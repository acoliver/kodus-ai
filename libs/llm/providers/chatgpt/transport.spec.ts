/**
 * The wire: request rules, SSE accumulation and terminal handling. Ports
 * OpenCodeReview `TestChatGPTStreamTerminal`, `TestChatGPTRejectsOverrides`,
 * `TestChatGPTLateFailureAndWrongNamespace`,
 * `TestChatGPTFallbackCallAndCredentialFailure`, the accumulator tests of
 * `responses_client_test.go` and `TestChatGPTStreamFailureDetails`.
 */
import { classifyLLMError, LlmErrorCategory } from '@libs/llm/error-classifier';
import { CHATGPT_RESPONSES_URL, CHATGPT_USAGE_URL } from './constants';
import { REJECTED_REQUEST_FIELDS, siwcFetch, toPlanRequest } from './transport';
import {
    completed,
    message,
    sdkBody,
    sseResponse,
    type SseEvent,
} from './__fixtures__/sse';

interface Sent {
    url: string;
    body: Record<string, any>;
    headers: Headers;
    redirect?: RequestRedirect;
}

function harness(
    reply: (sent: Sent) => Response | Promise<Response>,
    accessToken: () => Promise<string> = async () => 'access-fixture',
) {
    const sent: Sent[] = [];
    const doFetch = siwcFetch({
        credentialId: 'cred-1',
        tokenSource: () => ({ accessToken }),
        inner: async (url, init) => {
            const s = {
                url: String(url),
                body: JSON.parse(String(init.body)),
                headers: new Headers(init.headers),
                redirect: init.redirect,
            };
            sent.push(s);
            return reply(s);
        },
    });
    const post = (
        body: Record<string, unknown> = sdkBody(),
        init: RequestInit = {},
    ) =>
        doFetch(CHATGPT_RESPONSES_URL, {
            method: 'POST',
            headers: { authorization: 'Bearer placeholder' },
            body: JSON.stringify(body),
            ...init,
        });
    return { sent, post };
}

const ok = () => sseResponse([completed([message('ok')])]);

describe('toPlanRequest', () => {
    it('streams, keeps store false and strips max_output_tokens', () => {
        const wire = toPlanRequest(sdkBody({ max_output_tokens: 99 }));
        expect(wire.stream).toBe(true);
        expect(wire.store).toBe(false);
        expect('max_output_tokens' in wire).toBe(false);
    });

    it.each(REJECTED_REQUEST_FIELDS)('rejects %s', (field) => {
        expect(() => toPlanRequest(sdkBody({ [field]: 1 }))).toThrow(field);
    });

    it.each([
        ['store true', { store: true }],
        ['store missing', { store: undefined }],
        ['no encrypted reasoning', { include: [] }],
        ['system message', { input: [{ role: 'system', content: 'x' }] }],
        [
            'typed system message',
            { input: [{ type: 'message', role: 'system', content: 'x' }] },
        ],
        [
            'function call without namespace',
            {
                input: [
                    {
                        type: 'function_call',
                        call_id: 'c',
                        name: 'f',
                        arguments: '{}',
                    },
                ],
            },
        ],
        ['bare function tool', { tools: [{ type: 'function', name: 'f' }] }],
        ['web search', { tools: [{ type: 'web_search' }] }],
        [
            'foreign namespace',
            { tools: [{ type: 'namespace', name: 'ocr', tools: [] }] },
        ],
        [
            'non-function inside namespace',
            {
                tools: [
                    {
                        type: 'namespace',
                        name: 'kodus',
                        tools: [{ type: 'mcp' }],
                    },
                ],
            },
        ],
        ['named tool choice', { tool_choice: { type: 'function', name: 'f' } }],
    ])('rejects %s', (_n, over) => {
        const body = sdkBody(over);
        if ('store' in over && over.store === undefined) delete body.store;
        expect(() => toPlanRequest(body)).toThrow();
    });

    it('accepts namespaced tools, replayed calls and the allowed options', () => {
        expect(() =>
            toPlanRequest(
                sdkBody({
                    input: [
                        { role: 'developer', content: 'x' },
                        {
                            type: 'function_call',
                            call_id: 'c',
                            name: 'f',
                            arguments: '{}',
                            namespace: 'kodus',
                        },
                        {
                            type: 'function_call_output',
                            call_id: 'c',
                            output: 'y',
                        },
                    ],
                    tools: [
                        {
                            type: 'namespace',
                            name: 'kodus',
                            description: 'd',
                            tools: [{ type: 'function', name: 'f' }],
                        },
                    ],
                    tool_choice: 'required',
                    reasoning: { effort: 'high' },
                    text: { format: { type: 'json_schema' } },
                    prompt_cache_key: 'k',
                    parallel_tool_calls: true,
                }),
            ),
        ).not.toThrow();
    });
});

describe('siwcFetch', () => {
    it('sends a streaming request with the session token to the Responses endpoint', async () => {
        const { sent, post } = harness(ok);
        const res = await post(sdkBody({ max_output_tokens: 10 }));
        expect(sent[0].url).toBe(CHATGPT_RESPONSES_URL);
        expect(sent[0].redirect).toBe('manual');
        expect(sent[0].headers.get('authorization')).toBe(
            'Bearer access-fixture',
        );
        expect(sent[0].headers.get('accept')).toBe('text/event-stream');
        expect(sent[0].body.stream).toBe(true);
        expect(sent[0].body.store).toBe(false);
        expect(sent[0].body.max_output_tokens).toBeUndefined();
        expect(res.status).toBe(200);
        expect(res.headers.get('x-request-id')).toBe('req-stream');
        const body = await res.json();
        expect(body.status).toBe('completed');
        expect(body.output[0].content[0].text).toBe('ok');
    });

    it('refuses any other URL or method without calling out', async () => {
        const { sent } = harness(ok);
        const doFetch = siwcFetch({
            credentialId: 'cred-1',
            tokenSource: () => ({ accessToken: async () => 'x' }),
            inner: async () => ok(),
        });
        await expect(
            doFetch('https://evil.invalid/v1/responses', {
                method: 'POST',
                body: '{}',
            }),
        ).rejects.toThrow('may only POST');
        await expect(
            doFetch(CHATGPT_RESPONSES_URL, { method: 'GET' }),
        ).rejects.toThrow('may only POST');
        expect(sent).toHaveLength(0);
    });

    it('rejects temperature before asking for a token', async () => {
        let asked = 0;
        const { sent, post } = harness(ok, async () => {
            asked++;
            return 'x';
        });
        await expect(post(sdkBody({ temperature: 0.7 }))).rejects.toThrow(
            'temperature',
        );
        expect(asked).toBe(0);
        expect(sent).toHaveLength(0);
    });

    it('propagates a token-source failure with its classification', async () => {
        const failure = Object.assign(new Error('signed out'), {});
        const { sent, post } = harness(ok, async () => {
            throw failure;
        });
        await expect(post()).rejects.toBe(failure);
        expect(sent).toHaveLength(0);
    });

    it('an aborted caller fails at once while the token request keeps running', async () => {
        let resolveToken!: (v: string) => void;
        let tokenSettled = false;
        const tokenPromise = new Promise<string>(
            (r) => (resolveToken = r),
        ).then((v) => {
            tokenSettled = true;
            return v;
        });
        const { sent, post } = harness(ok, () => tokenPromise);
        const controller = new AbortController();
        const pending = post(sdkBody(), { signal: controller.signal });
        controller.abort();
        await expect(pending).rejects.toBeDefined();
        resolveToken('rotated');
        await tokenPromise;
        expect(tokenSettled).toBe(true);
        expect(sent).toHaveLength(0);
    });

    it.each<[string, SseEvent[], LlmErrorCategory | undefined]>([
        [
            'failed',
            [
                { type: 'response.output_text.delta', delta: 'partial' },
                {
                    type: 'response.failed',
                    response: {
                        status: 'failed',
                        error: {
                            code: 'subscription_sharing_usage_limit_exceeded',
                            message: 'limit',
                        },
                    },
                },
            ],
            LlmErrorCategory.QUOTA_EXCEEDED,
        ],
        [
            'incomplete',
            [
                {
                    type: 'response.incomplete',
                    response: {
                        status: 'incomplete',
                        incomplete_details: { reason: 'content_filter' },
                    },
                },
            ],
            LlmErrorCategory.REQUEST_REJECTED,
        ],
        [
            'error',
            [
                {
                    type: 'error',
                    code: 'subscription_sharing_usage_limit_exceeded',
                    message: 'limit',
                },
            ],
            LlmErrorCategory.QUOTA_EXCEEDED,
        ],
        [
            'interrupted',
            [{ type: 'response.output_text.delta', delta: 'partial' }],
            LlmErrorCategory.TRANSIENT,
        ],
        [
            'wrong status',
            [
                {
                    type: 'response.completed',
                    response: { status: 'incomplete', output: [] },
                },
            ],
            LlmErrorCategory.TRANSIENT,
        ],
        [
            'completed then failed',
            [
                {
                    type: 'response.completed',
                    response: { status: 'completed', output: [] },
                },
                {
                    type: 'response.failed',
                    response: {
                        status: 'failed',
                        error: {
                            code: 'subscription_sharing_usage_unavailable',
                            message: 'unavailable',
                            param: 'usage',
                        },
                    },
                },
            ],
            LlmErrorCategory.TRANSIENT,
        ],
    ])('terminal %s is not accepted', async (_n, events, category) => {
        const { post } = harness(() => sseResponse(events));
        const err = await post().catch((e) => e);
        expect(err).toBeInstanceOf(Error);
        expect(classifyLLMError(err).category).toBe(category);
    });

    it('a late failure keeps code, param and the usage link', async () => {
        const { post } = harness(() =>
            sseResponse([
                {
                    type: 'response.failed',
                    response: {
                        status: 'failed',
                        error: {
                            code: 'subscription_sharing_usage_unavailable',
                            message: 'unavailable',
                            param: 'usage',
                        },
                    },
                },
            ]),
        );
        const err = await post().catch((e) => e);
        expect(err.message).toContain('subscription_sharing_usage_unavailable');
        expect(err.message).toContain('param="usage"');
        expect(err.message).toContain(CHATGPT_USAGE_URL);
        expect(err.message).toContain('request_id="req-stream"');
    });

    it('rebuilds an empty terminal output from output_item.done in index order', async () => {
        const { post } = harness(() =>
            sseResponse([
                {
                    type: 'response.output_item.done',
                    output_index: 1,
                    item: message('second', 'b'),
                },
                {
                    type: 'response.output_item.done',
                    output_index: 0,
                    item: message('first', 'a'),
                },
                completed([]),
            ]),
        );
        const body = await (await post()).json();
        expect(body.output.map((o: any) => o.id)).toEqual(['a', 'b']);
    });

    it('prefers a non-empty terminal output', async () => {
        const { post } = harness(() =>
            sseResponse([
                {
                    type: 'response.output_item.done',
                    output_index: 0,
                    item: message('streamed', 'a'),
                },
                completed([message('terminal', 't')]),
            ]),
        );
        const body = await (await post()).json();
        expect(body.output.map((o: any) => o.id)).toEqual(['t']);
    });

    it.each([
        [
            'many items',
            () =>
                Array.from({ length: 300 }, (_, i) => ({
                    type: 'response.output_item.done',
                    output_index: i,
                    item: message('x'.repeat(60_000)),
                })),
        ],
        [
            'one big item',
            () => [
                {
                    type: 'response.output_item.done',
                    output_index: 0,
                    item: message('x'.repeat(16 << 20)),
                },
            ],
        ],
        [
            'terminal over the limit',
            () => [completed([message('x'.repeat(16 << 20))])],
        ],
    ])('enforces the 16 MiB output limit: %s', async (_n, events) => {
        const { post } = harness(() => sseResponse(events() as SseEvent[]));
        const err = await post().catch((e) => e);
        expect(err.message).toContain('output_limit_exceeded');
        expect(classifyLLMError(err).category).toBe(
            LlmErrorCategory.REQUEST_REJECTED,
        );
    });

    it('rejects a function call outside the Kodus namespace', async () => {
        const { post } = harness(() =>
            sseResponse([
                completed([
                    {
                        type: 'function_call',
                        name: 'read_file',
                        namespace: 'unknown',
                        call_id: 'c',
                        arguments: '{}',
                    },
                ]),
            ]),
        );
        await expect(post()).rejects.toThrow(
            'outside the offered Kodus namespace',
        );
    });

    it('maps an HTTP error with the token redacted', async () => {
        const { post } = harness(
            () =>
                new Response(
                    JSON.stringify({
                        error: {
                            code: 'subscription_sharing_model_not_eligible',
                            param: 'model',
                            message: 'model not eligible for access-fixture',
                        },
                    }),
                    { status: 403, headers: { 'x-request-id': 'req-model' } },
                ),
        );
        const err = await post().catch((e) => e);
        expect(err.statusCode).toBe(403);
        expect(err.isRetryable).toBe(false);
        expect(err.message).toContain(
            'subscription_sharing_model_not_eligible',
        );
        expect(err.message).toContain('param="model"');
        expect(err.message).toContain('req-model');
        expect(err.message).not.toContain('access-fixture');
    });

    it('treats a redirect as an error', async () => {
        const { post } = harness(
            () =>
                new Response('', {
                    status: 307,
                    headers: { location: 'https://evil.invalid' },
                }),
        );
        const err = await post().catch((e) => e);
        expect(err.statusCode).toBe(307);
    });
});
