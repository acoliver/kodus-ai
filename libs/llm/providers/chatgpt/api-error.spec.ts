/**
 * Error shapes, redaction and the recovery table. Ports OpenCodeReview
 * `TestCatalogErrorBoundsAndShapes` and `TestModelsAPIDiagnostics`, plus
 * every row of the design's error-mapping table.
 */
import { classifyLLMError, LlmErrorCategory } from '@libs/llm/error-classifier';
import {
    describeErrorBody,
    diagnosticText,
    siwcHttpError,
    siwcStreamError,
} from './api-error';
import { CHATGPT_RESPONSES_URL, CHATGPT_USAGE_URL } from './constants';

const secrets = ['access', 'refresh', 'long-id-token'];

describe('describeErrorBody', () => {
    it.each([
        ['[]', 'array'],
        ['"unsafe access"', 'string'],
        ['123', 'number'],
        ['null', 'null'],
        ['true', 'boolean'],
        ['{"other":"access"}', 'object'],
        ['{"error":{},"detail":"route restriction"}', 'error_object'],
        ['{"detail":"region restriction"}', 'detail'],
        ['{"error":"not eligible"}', 'error_string'],
        ['not-json access', 'non_json'],
    ])('%s → %s', (body, shape) => {
        const d = describeErrorBody(401, 'req', body, secrets);
        expect(d.shape).toBe(shape);
        expect(JSON.stringify(d)).not.toContain('"access"');
        if (body.includes('route restriction')) {
            expect(d.detail).toBe('route restriction');
        }
    });

    it('reads code, param and message from an error object', () => {
        const d = describeErrorBody(
            403,
            'req-catalog',
            '{"error":{"code":"subscription_sharing_user_not_eligible","param":"model","message":"workspace not eligible"}}',
        );
        expect(d).toMatchObject({
            code: 'subscription_sharing_user_not_eligible',
            param: 'model',
            detail: 'workspace not eligible',
            requestId: 'req-catalog',
            shape: 'error_object',
        });
    });

    it('marks an oversized body', () => {
        expect(describeErrorBody(403, 'req-bound', undefined).shape).toBe(
            'oversized',
        );
    });
});

describe('diagnosticText', () => {
    it('strips control characters, redacts secrets and caps at 1024', () => {
        const raw =
            "safe \x1b\n\r\t\x00 text access refresh long-id-token token='other secret' " +
            'z'.repeat(1023) +
            '\u20ac';
        const got = diagnosticText(raw, secrets);
        // eslint-disable-next-line no-control-regex
        expect(got).not.toMatch(/[\x1b\n\r\t\x00]/);
        expect(got.endsWith('... (truncated)')).toBe(true);
        expect(got.length).toBeLessThanOrEqual(1040);
        for (const s of [
            'access',
            'refresh',
            'long-id-token',
            'other secret',
        ]) {
            expect(got).not.toContain(s);
        }
    });

    it('redacts token-shaped strings', () => {
        const got = diagnosticText(
            'Bearer abc token=refresh id secret sk-secret123 eyJhbGciOiJSUzI1NiJ9.payload.signature',
        );
        for (const s of [
            'Bearer abc',
            'token=refresh',
            'sk-secret123',
            'eyJhbGciOiJSUzI1NiJ9.payload.signature',
        ]) {
            expect(got).not.toContain(s);
        }
    });
});

const headers = (id = 'req-1') => new Headers({ 'x-request-id': id });
const responsesError = (code: string, param = '') =>
    JSON.stringify({ error: { code, param, message: 'm' } });

describe('siwcHttpError recovery table', () => {
    it.each<[string, number, string | undefined, LlmErrorCategory, boolean]>([
        [
            'admission 401',
            401,
            '{"detail":"no"}',
            LlmErrorCategory.AUTH_INVALID,
            false,
        ],
        [
            'admission 403',
            403,
            '{"detail":"region"}',
            LlmErrorCategory.AUTH_INVALID,
            false,
        ],
        [
            'admission 503',
            503,
            '{"detail":"off"}',
            LlmErrorCategory.TRANSIENT,
            true,
        ],
        [
            'not eligible',
            403,
            responsesError('subscription_sharing_user_not_eligible'),
            LlmErrorCategory.AUTH_INVALID,
            false,
        ],
        [
            'usage limit',
            429,
            responsesError('subscription_sharing_usage_limit_exceeded'),
            LlmErrorCategory.QUOTA_EXCEEDED,
            false,
        ],
        [
            'usage unavailable',
            503,
            responsesError('subscription_sharing_usage_unavailable'),
            LlmErrorCategory.TRANSIENT,
            true,
        ],
        [
            'unsupported capability',
            400,
            responsesError(
                'subscription_sharing_unsupported_capability',
                'tools',
            ),
            LlmErrorCategory.REQUEST_REJECTED,
            false,
        ],
        [
            'route',
            403,
            responsesError('subscription_sharing_route_not_supported'),
            LlmErrorCategory.REQUEST_REJECTED,
            false,
        ],
        [
            'invalid user',
            401,
            responsesError('subscription_sharing_invalid_user'),
            LlmErrorCategory.AUTH_INVALID,
            false,
        ],
        [
            'scope',
            403,
            responsesError('chatpass_v2_scope_not_authorized'),
            LlmErrorCategory.AUTH_INVALID,
            false,
        ],
        [
            'context',
            403,
            responsesError('chatpass_v2_invalid_authorization_context'),
            LlmErrorCategory.AUTH_INVALID,
            false,
        ],
        [
            'user unavailable',
            503,
            responsesError('subscription_sharing_user_unavailable'),
            LlmErrorCategory.TRANSIENT,
            true,
        ],
        ['other 5xx', 502, 'bad gateway', LlmErrorCategory.TRANSIENT, true],
        ['oversized', 403, undefined, LlmErrorCategory.AUTH_INVALID, false],
    ])('%s', (_name, status, body, category, retryable) => {
        const err = siwcHttpError({
            url: CHATGPT_RESPONSES_URL,
            status,
            headers: headers(),
            body,
            secrets,
        });
        expect(err.statusCode).toBe(status);
        expect(err.isRetryable).toBe(retryable);
        expect(classifyLLMError(err).category).toBe(category);
        expect(err.message).toContain('request_id="req-1"');
    });

    it('usage limit names the usage page and is never retried by the SDK', () => {
        const err = siwcHttpError({
            url: CHATGPT_RESPONSES_URL,
            status: 429,
            headers: headers(),
            body: responsesError('subscription_sharing_usage_limit_exceeded'),
            secrets,
        });
        expect(err.message).toContain(CHATGPT_USAGE_URL);
        expect(classifyLLMError(err).friendlyMessage).toContain(
            CHATGPT_USAGE_URL,
        );
    });

    it('an unknown 4xx code is left to the generic classifier, retried only on 429', () => {
        const rejected = siwcHttpError({
            url: CHATGPT_RESPONSES_URL,
            status: 400,
            headers: headers(),
            body: responsesError('invalid_model', 'model'),
            secrets,
        });
        expect(rejected.isRetryable).toBe(false);
        expect(classifyLLMError(rejected).category).toBe(
            LlmErrorCategory.REQUEST_REJECTED,
        );
        const limited = siwcHttpError({
            url: CHATGPT_RESPONSES_URL,
            status: 429,
            headers: headers(),
            body: responsesError('rate_limit_exceeded'),
            secrets,
        });
        expect(limited.isRetryable).toBe(true);
    });

    it('carries the param and never a credential', () => {
        const err = siwcHttpError({
            url: CHATGPT_RESPONSES_URL,
            status: 400,
            headers: headers(),
            body: JSON.stringify({
                error: {
                    code: 'subscription_sharing_unsupported_capability',
                    param: 'tools',
                    message: 'Bearer access token=refresh sk-secret123',
                },
            }),
            secrets,
        });
        expect(err.message).toContain('param="tools"');
        expect(classifyLLMError(err).friendlyMessage).toContain('param: tools');
        for (const s of ['Bearer access', 'token=refresh', 'sk-secret123']) {
            expect(err.message).not.toContain(s);
            expect(err.responseBody).not.toContain(s);
        }
    });
});

describe('siwcStreamError', () => {
    it('usage limit in response.failed is a terminal quota error', () => {
        const err = siwcStreamError({
            url: CHATGPT_RESPONSES_URL,
            event: 'response.failed',
            code: 'subscription_sharing_usage_limit_exceeded',
            message: 'limit',
            requestId: 'req',
            secrets,
        });
        expect(err.statusCode).toBe(429);
        expect(err.isRetryable).toBe(false);
        expect(classifyLLMError(err).category).toBe(
            LlmErrorCategory.QUOTA_EXCEEDED,
        );
        expect(err.message).toContain(CHATGPT_USAGE_URL);
    });

    it('response.incomplete is a rejected request carrying its details', () => {
        const err = siwcStreamError({
            url: CHATGPT_RESPONSES_URL,
            event: 'response.incomplete',
            incompleteDetails: { reason: 'content_filter' },
            requestId: 'req',
            secrets,
        });
        expect(err.statusCode).toBe(400);
        expect(classifyLLMError(err).category).toBe(
            LlmErrorCategory.REQUEST_REJECTED,
        );
        expect(err.message).toContain('content_filter');
    });

    it('keeps code and param of a late failure', () => {
        const err = siwcStreamError({
            url: CHATGPT_RESPONSES_URL,
            event: 'response.failed',
            code: 'subscription_sharing_usage_unavailable',
            param: 'usage',
            message: 'unavailable',
            requestId: 'req',
            secrets,
        });
        expect(err.message).toContain('subscription_sharing_usage_unavailable');
        expect(err.message).toContain('param="usage"');
        expect(err.isRetryable).toBe(true);
    });
});
