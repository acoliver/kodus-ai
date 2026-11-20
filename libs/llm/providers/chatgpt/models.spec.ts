/**
 * The account model catalog. Ports OpenCodeReview `TestModelsCatalog`,
 * `TestCatalogRequestFailurePaths` and `TestModelsAPIDiagnostics`.
 */
import { classifyLLMError, LlmErrorCategory } from '@libs/llm/error-classifier';
import { listChatGptModels, parseChatGptModels } from './models';
import { CHATGPT_MODELS_URL } from './constants';
import { json } from './__fixtures__/fake-openai';

const catalog = {
    models: [
        { slug: 'second', display_name: 'Second', visibility: 'list' },
        { slug: 'hidden', display_name: 'Hidden', visibility: 'hide' },
        { slug: 'first', display_name: 'First', visibility: 'list' },
    ],
};

describe('parseChatGptModels', () => {
    it('keeps listed models in server order with their display names', () => {
        expect(parseChatGptModels(catalog).map((m) => [m.id, m.name])).toEqual([
            ['second', 'Second'],
            ['first', 'First'],
        ]);
    });

    it.each([
        ['no models field', { data: [] }],
        ['a listed entry without slug', { models: [{ visibility: 'list' }] }],
        [
            'a listed entry without display name',
            { models: [{ slug: 's', visibility: 'list' }] },
        ],
    ])('rejects %s', (_n, body) => {
        expect(() => parseChatGptModels(body)).toThrow();
    });

    it('derives reasoning support from the slug', () => {
        const [m] = parseChatGptModels({
            models: [
                {
                    slug: 'gpt-6.1-sol',
                    display_name: 'Sol',
                    visibility: 'list',
                },
            ],
        });
        expect(m.supportsReasoning).toBe(true);
    });
});

describe('listChatGptModels', () => {
    it('GETs the catalog with the access token and no redirects', async () => {
        let seen: { url: string; init: RequestInit } | undefined;
        const models = await listChatGptModels('access', async (url, init) => {
            seen = { url: String(url), init };
            return json(catalog);
        });
        expect(seen.url).toBe(CHATGPT_MODELS_URL);
        expect(seen.init.redirect).toBe('manual');
        expect(
            (seen.init.headers as Record<string, string>).Authorization,
        ).toBe('Bearer access');
        expect(models.map((m) => m.id)).toEqual(['second', 'first']);
    });

    it.each([
        [
            'eligibility',
            '{"error":{"code":"subscription_sharing_user_not_eligible","param":"model","message":"workspace not eligible"}}',
            'error_object',
        ],
        ['region', '{"detail":"region restriction"}', 'detail'],
        [
            'redaction',
            '{"error":{"code":"invalid_model","param":"model","message":"Bearer access token=refresh sk-secret123"}}',
            'error_object',
        ],
        ['non json', 'not-json access', 'non_json'],
    ])(
        'a 403 (%s) keeps status, request id and shape, redacted',
        async (_n, body, shape) => {
            const err = await listChatGptModels(
                'access',
                async () =>
                    new Response(body, {
                        status: 403,
                        headers: { 'x-request-id': 'req-catalog' },
                    }),
            ).catch((e) => e);
            expect(err.statusCode).toBe(403);
            expect(err.message).toContain('request_id="req-catalog"');
            expect(err.message).toContain(`body_shape=${shape}`);
            for (const s of [
                'Bearer access',
                'token=refresh',
                'sk-secret123',
            ]) {
                expect(err.message).not.toContain(s);
            }
        },
    );

    it.each([
        ['network', async () => Promise.reject(new TypeError('fetch failed'))],
        [
            'oversized error',
            async () =>
                new Response('x'.repeat((1 << 20) + 1), {
                    status: 403,
                    headers: { 'x-request-id': 'req-bound' },
                }),
        ],
        [
            'oversized success',
            async () =>
                new Response('x'.repeat((1 << 20) + 1), {
                    headers: { 'x-request-id': 'req-bound' },
                }),
        ],
        ['invalid json', async () => new Response('invalid-json')],
    ])('%s fails', async (scenario, fetchFn) => {
        const err = await listChatGptModels(
            'access',
            fetchFn as typeof fetch,
        ).catch((e) => e);
        expect(err).toBeInstanceOf(Error);
        if (scenario.startsWith('oversized')) {
            expect(err.message).toContain('body_shape=oversized');
            expect(err.message).toContain('req-bound');
            expect(err.message.length).toBeLessThan(2048);
        }
        if (scenario === 'network') {
            expect(classifyLLMError(err).category).toBe(
                LlmErrorCategory.TRANSIENT,
            );
        }
    });
});
