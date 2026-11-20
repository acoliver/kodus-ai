/**
 * The chatgpt module end to end through the AI SDK and through `LLM.run`, with
 * only the network replaced. Ports OpenCodeReview
 * `TestChatGPTRequestNamespaceAndReplay`, `TestChatGPTNativeToolHTTPRoundTrip`,
 * `TestChatGPTCapabilityStatus` and
 * `TestOpenAIResponsesClient_StreamingSSEPreservesNativeReasoning`.
 */
import { generateText, Output, stepCountIs, tool } from 'ai';
import { z } from 'zod';
import { LLM } from '@libs/llm/llm';
import { REGISTRY } from '../index';
import { chatgptModule } from './index';
import { setChatGptTokenSource } from './token-source';
import { CHATGPT_RESPONSES_URL } from './constants';
import {
    completed,
    message,
    sseResponse,
    type SseEvent,
} from './__fixtures__/sse';
import type { ProviderBuildConfig } from '../kernel/types';

const cfg = {
    provider: 'chatgpt',
    model: 'gpt-6.1-sol',
    apiKey: '',
    credentialId: 'cred-1',
} as ProviderBuildConfig;

function wire(replies: Array<SseEvent[]>) {
    const bodies: Array<Record<string, any>> = [];
    const urls: string[] = [];
    const fetchFn = (async (url: string, init: RequestInit) => {
        urls.push(String(url));
        bodies.push(JSON.parse(String(init.body)));
        const events = replies[bodies.length - 1];
        if (!events) throw new Error('unexpected extra request');
        return sseResponse(events);
    }) as unknown as typeof fetch;
    return { bodies, urls, fetchFn };
}

const FUNCTION_CALL = {
    type: 'function_call',
    namespace: 'kodus',
    name: 'read_file',
    call_id: 'call_1',
    id: 'fc_1',
    arguments: '{"path":"a.ts"}',
    status: 'completed',
};
const REASONING = {
    type: 'reasoning',
    id: 'rs_1',
    summary: [],
    encrypted_content: 'ciphertext',
};

beforeEach(() => {
    setChatGptTokenSource({ accessToken: async () => 'access-fixture' });
});

describe('chatgpt module through generateText', () => {
    it('runs a two-step tool loop with namespaced tools and encrypted reasoning replay', async () => {
        const { bodies, urls, fetchFn } = wire([
            [
                {
                    type: 'response.output_item.done',
                    output_index: 0,
                    item: REASONING,
                },
                {
                    type: 'response.output_item.done',
                    output_index: 1,
                    item: FUNCTION_CALL,
                },
                completed([]),
            ],
            [
                completed([message('Reviewed')], {
                    input_tokens: 14,
                    output_tokens: 3,
                    total_tokens: 17,
                }),
            ],
        ]);
        const result = await generateText({
            model: chatgptModule.build(cfg, { fetch: fetchFn }),
            system: 'review policy',
            prompt: 'review a.ts',
            maxOutputTokens: 4096,
            tools: {
                read_file: tool({
                    description: 'Read a file',
                    inputSchema: z.object({ path: z.string() }),
                    execute: async () => 'package main',
                }),
            },
            stopWhen: stepCountIs(2),
            providerOptions: chatgptModule.reasoning(cfg, 'high') as any,
        });

        expect(urls).toEqual([CHATGPT_RESPONSES_URL, CHATGPT_RESPONSES_URL]);
        const [first, second] = bodies;
        expect(first.stream).toBe(true);
        expect(first.store).toBe(false);
        expect(first.include).toContain('reasoning.encrypted_content');
        expect(first.max_output_tokens).toBeUndefined();
        expect(first.temperature).toBeUndefined();
        expect(first.reasoning).toEqual({ effort: 'high' });
        expect(first.input[0]).toMatchObject({
            role: 'developer',
            content: 'review policy',
        });
        expect(first.tools).toEqual([
            {
                type: 'namespace',
                name: 'kodus',
                description: 'Kodus code review tools',
                tools: [
                    expect.objectContaining({
                        type: 'function',
                        name: 'read_file',
                    }),
                ],
            },
        ]);

        const replayed = JSON.stringify(second.input);
        expect(second.input).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    type: 'reasoning',
                    encrypted_content: 'ciphertext',
                }),
                expect.objectContaining({
                    type: 'function_call',
                    call_id: 'call_1',
                    namespace: 'kodus',
                    name: 'read_file',
                }),
                expect.objectContaining({
                    type: 'function_call_output',
                    call_id: 'call_1',
                }),
            ]),
        );
        expect(replayed).toContain('package main');

        expect(result.text).toBe('Reviewed');
        expect(result.steps[0].toolCalls[0].toolName).toBe('read_file');
        expect(result.steps[0].usage.outputTokenDetails.reasoningTokens).toBe(
            7,
        );
    });

    it('sends text.format json_schema for a structured call', async () => {
        const { bodies, fetchFn } = wire([
            [completed([message('{"ok":true}')])],
        ]);
        const result = await generateText({
            model: chatgptModule.build(cfg, { fetch: fetchFn }),
            prompt: 'answer',
            output: Output.object({ schema: z.object({ ok: z.boolean() }) }),
        });
        expect(bodies[0].text.format.type).toBe('json_schema');
        expect(result.output).toEqual({ ok: true });
    });

    it('omits reasoning entirely at effort none', async () => {
        const { bodies, fetchFn } = wire([[completed([message('ok')])]]);
        await generateText({
            model: chatgptModule.build(cfg, { fetch: fetchFn }),
            prompt: 'hi',
            providerOptions: chatgptModule.reasoning(cfg, 'none') as any,
        });
        expect(bodies[0].reasoning).toBeUndefined();
    });

    it('refuses a named toolChoice before any request', async () => {
        const { bodies, fetchFn } = wire([]);
        await expect(
            generateText({
                model: chatgptModule.build(cfg, { fetch: fetchFn }),
                prompt: 'hi',
                tools: { read_file: tool({ inputSchema: z.object({}) }) },
                toolChoice: { type: 'tool', toolName: 'read_file' },
            }),
        ).rejects.toThrow('named tool_choice');
        expect(bodies).toHaveLength(0);
    });

    it('refuses streaming', async () => {
        const model = chatgptModule.build(cfg) as any;
        await expect(model.doStream({ prompt: [] })).rejects.toThrow(
            'generate calls only',
        );
    });
});

describe('chatgpt module contract', () => {
    it('is registered under chatgpt', () => {
        expect(REGISTRY.get('chatgpt')).toBe(chatgptModule);
    });

    it('build fails without a credential id', () => {
        expect(() =>
            chatgptModule.build({ ...cfg, credentialId: undefined }),
        ).toThrow('no credentialId');
    });

    it('declares json_schema, native tools, no temperature and no UI fields', () => {
        expect(chatgptModule.structuredOutputPolicy(cfg)).toBe('json_schema');
        expect(chatgptModule.temperaturePolicy(cfg)).toEqual({
            kind: 'unsupported',
        });
        expect(chatgptModule.capabilities('gpt-6.1-sol')).toMatchObject({
            supportsReasoning: true,
            structuredOutput: 'json_schema',
            toolCalling: 'native',
        });
        expect(chatgptModule.uiFields).toEqual([]);
        expect(chatgptModule.selfHostedEnv('chatgpt')).toBeNull();
        expect(chatgptModule.modelListing('chatgpt')).toMatchObject({
            kind: 'http',
        });
        expect(chatgptModule.modelListing('openai')).toBeNull();
    });

    it('maps effort to forced reasoning with no default summary', () => {
        expect(chatgptModule.reasoning(cfg, 'none')).toEqual({});
        expect(chatgptModule.reasoning(cfg, 'medium')).toEqual({
            openai: {
                reasoningEffort: 'medium',
                forceReasoning: true,
                reasoningSummary: null,
            },
        });
    });
});

describe('chatgpt slot through LLM.run', () => {
    const realFetch = globalThis.fetch;
    afterEach(() => {
        globalThis.fetch = realFetch;
    });

    it('a structured review call reaches /v1/responses with the plan wire rules', async () => {
        const { bodies, fetchFn } = wire([
            [completed([message('{"ok":true}')])],
        ]);
        globalThis.fetch = fetchFn;
        const out = await LLM.run({
            byokConfig: { ...cfg, reasoningEffort: 'high' } as any,
            user: 'answer',
            schema: z.object({ ok: z.boolean() }),
            runName: 'chatgpt-spec',
        } as any);
        expect(out).toEqual({ ok: true });
        const body = bodies[0];
        expect(body.store).toBe(false);
        expect(body.stream).toBe(true);
        expect(body.text.format.type).toBe('json_schema');
        expect(body.reasoning).toEqual({ effort: 'high' });
        expect(body.max_output_tokens).toBeUndefined();
        expect(body.temperature).toBeUndefined();
    });
});
