/**
 * ChatGPT-plan failures as AI SDK `APICallError`s carrying an attached
 * classification. Port of OpenCodeReview `internal/chatgptauth/api_error.go`
 * (body-shape detection, redaction, 1024-char cap) plus the recovery table of
 * OpenAI's "Errors and recovery" page.
 *
 * Every error states `isRetryable` explicitly: the AI SDK would otherwise
 * retry any 429, and a spent ChatGPT plan must not be asked again.
 */
import { APICallError } from 'ai';
import {
    attachClassification,
    LlmErrorCategory,
} from '@libs/llm/error-classifier';
import { CHATGPT_PROVIDER_ID, CHATGPT_USAGE_URL } from './constants';

export type BodyShape =
    | 'non_json'
    | 'array'
    | 'string'
    | 'null'
    | 'boolean'
    | 'number'
    | 'object'
    | 'error_object'
    | 'error_string'
    | 'detail'
    | 'oversized'
    | 'stream';

export interface SiwcDiagnostic {
    status: number;
    code: string;
    param: string;
    requestId: string;
    shape: BodyShape;
    detail: string;
}

const SECRET_PATTERNS = [
    /\bBearer\s+[^\s,;"']+/gi,
    /\b(?:access_token|refresh_token|id_token|api_key|token|authorization)\s*[=:]\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi,
    /\bsk-[A-Za-z0-9_-]+/g,
    /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g,
];
const MAX_DIAGNOSTIC = 1024;

// Control characters, plus the two line separators JSON allows unescaped.
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g;

const LONE_SURROGATE =
    /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

const wellFormed = (s: string) => s.replace(LONE_SURROGATE, '');
const clean = (s: string) => wellFormed(s).replace(CONTROL, '');

/** Make provider text safe to log and show: control characters stripped, the
 *  session's own tokens and anything token-shaped replaced, capped. */
export function diagnosticText(
    text: string,
    secrets: readonly (string | undefined)[] = [],
): string {
    let out = clean(text);
    for (const secret of secrets) {
        const s = secret ? clean(secret) : '';
        if (s) out = out.split(s).join('[REDACTED]');
    }
    for (const pattern of SECRET_PATTERNS) {
        out = out.replace(pattern, '[REDACTED]');
    }
    if (out.length > MAX_DIAGNOSTIC) {
        out = `${wellFormed(out.slice(0, MAX_DIAGNOSTIC))}... (truncated)`;
    }
    return out;
}

function shapeOf(value: unknown): BodyShape {
    if (value === null) return 'null';
    if (Array.isArray(value)) return 'array';
    switch (typeof value) {
        case 'string':
            return 'string';
        case 'boolean':
            return 'boolean';
        case 'number':
            return 'number';
        default:
            return 'object';
    }
}

const readString = (v: unknown, secrets: readonly (string | undefined)[]) =>
    typeof v === 'string' ? diagnosticText(v, secrets) : '';

/** Describe a non-2xx body without trusting its shape: a direct-admission
 *  `{detail}`, a Responses `{error:{code,param,message}}`, or anything else. */
export function describeErrorBody(
    status: number,
    requestId: string,
    body: string | undefined,
    secrets: readonly (string | undefined)[] = [],
): SiwcDiagnostic {
    const d: SiwcDiagnostic = {
        status,
        code: '',
        param: '',
        requestId: diagnosticText(requestId, secrets),
        shape: body === undefined ? 'oversized' : 'non_json',
        detail: body === undefined ? 'response exceeded size limit' : '',
    };
    if (body === undefined) return d;
    let parsed: unknown;
    try {
        parsed = JSON.parse(body);
    } catch {
        return d;
    }
    d.shape = shapeOf(parsed);
    if (d.shape !== 'object') return d;
    const fields = parsed as Record<string, unknown>;
    if ('error' in fields) {
        const nested = fields.error;
        if (nested && typeof nested === 'object' && !Array.isArray(nested)) {
            const e = nested as Record<string, unknown>;
            d.shape = 'error_object';
            d.code = readString(e.code, secrets);
            d.param = readString(e.param, secrets);
            d.detail = readString(e.message, secrets);
        } else if (typeof nested === 'string') {
            d.shape = 'error_string';
            d.detail = diagnosticText(nested, secrets);
        }
    }
    if ('detail' in fields) {
        if (d.shape === 'object') d.shape = 'detail';
        const text = readString(fields.detail, secrets);
        if (text) d.detail = d.detail ? `${d.detail}; ${text}` : text;
    }
    return d;
}

interface Recovery {
    category: LlmErrorCategory;
    retryable: boolean;
    action: string;
}

const SIGN_IN = 'Run `kodus chatgpt login` to sign in again.';
const USAGE = `Manage usage: ${CHATGPT_USAGE_URL}`;

/** Documented Responses error codes → status, category, retry, action. */
const CODE_RECOVERY: Record<string, Recovery & { status: number }> = {
    subscription_sharing_user_not_eligible: {
        status: 403,
        category: LlmErrorCategory.AUTH_INVALID,
        retryable: false,
        action: 'ChatGPT plan usage is unavailable for this user, workspace or policy.',
    },
    subscription_sharing_usage_limit_exceeded: {
        status: 429,
        category: LlmErrorCategory.QUOTA_EXCEEDED,
        retryable: false,
        action: `The ChatGPT plan usage limit was reached; requests are paused. ${USAGE}`,
    },
    subscription_sharing_usage_unavailable: {
        status: 503,
        category: LlmErrorCategory.TRANSIENT,
        retryable: true,
        action: 'ChatGPT plan usage could not be checked; retry later.',
    },
    subscription_sharing_unsupported_capability: {
        status: 400,
        category: LlmErrorCategory.REQUEST_REJECTED,
        retryable: false,
        action: 'The ChatGPT plan does not support part of this request.',
    },
    subscription_sharing_route_not_supported: {
        status: 403,
        category: LlmErrorCategory.REQUEST_REJECTED,
        retryable: false,
        action: 'Kodus called a route the ChatGPT plan does not serve.',
    },
    subscription_sharing_invalid_user: {
        status: 401,
        category: LlmErrorCategory.AUTH_INVALID,
        retryable: false,
        action: `The ChatGPT subscriber could not be validated. ${SIGN_IN}`,
    },
    chatpass_v2_scope_not_authorized: {
        status: 403,
        category: LlmErrorCategory.AUTH_INVALID,
        retryable: false,
        action: 'The ChatGPT grant does not authorize this operation; check the client and grant.',
    },
    chatpass_v2_invalid_authorization_context: {
        status: 403,
        category: LlmErrorCategory.AUTH_INVALID,
        retryable: false,
        action: 'The ChatGPT grant does not authorize this operation; check the client and grant.',
    },
    subscription_sharing_user_unavailable: {
        status: 503,
        category: LlmErrorCategory.TRANSIENT,
        retryable: true,
        action: 'ChatGPT user or workspace information is temporarily unavailable; retry later.',
    },
};

/** Direct-route admission answers (no Responses error code). */
function admissionRecovery(status: number): Recovery | undefined {
    if (status === 401) {
        return {
            category: LlmErrorCategory.AUTH_INVALID,
            retryable: false,
            action: `ChatGPT did not accept the signed identity or plan permission; check the selected ChatGPT account and granted scopes. ${SIGN_IN}`,
        };
    }
    if (status === 403) {
        return {
            category: LlmErrorCategory.AUTH_INVALID,
            retryable: false,
            action: 'A ChatGPT policy or region restriction refused the request.',
        };
    }
    if (status >= 500) {
        return {
            category: LlmErrorCategory.TRANSIENT,
            retryable: true,
            action: 'ChatGPT is temporarily unavailable; credentials are kept.',
        };
    }
    return undefined;
}

function describe(d: SiwcDiagnostic): string {
    return `ChatGPT API request failed: status=${d.status} code=${JSON.stringify(d.code)} param=${JSON.stringify(d.param)} request_id=${JSON.stringify(d.requestId)} body_shape=${d.shape} detail=${JSON.stringify(d.detail)}`;
}

/** Build a classified `APICallError`. `category` undefined leaves the
 *  ordinary status-based classifier in charge. */
export function siwcError(args: {
    message: string;
    url: string;
    status: number;
    retryable: boolean;
    category?: LlmErrorCategory;
    friendly?: string;
    responseBody?: string;
    responseHeaders?: Record<string, string>;
    cause?: unknown;
}): APICallError {
    const err = new APICallError({
        message: args.message,
        url: args.url,
        requestBodyValues: undefined,
        statusCode: args.status,
        responseHeaders: args.responseHeaders,
        responseBody: args.responseBody,
        isRetryable: args.retryable,
        cause: args.cause,
    });
    if (args.category) {
        attachClassification(err, {
            category: args.category,
            provider: CHATGPT_PROVIDER_ID,
            rawMessage: args.message,
            httpStatus: args.status,
            friendlyMessage: args.friendly ?? args.message,
        });
    }
    return err;
}

/** A non-2xx HTTP answer from api.openai.com (`body` undefined: oversized). */
export function siwcHttpError(args: {
    url: string;
    status: number;
    headers: Headers;
    body: string | undefined;
    secrets: readonly (string | undefined)[];
}): APICallError {
    const d = describeErrorBody(
        args.status,
        args.headers.get('x-request-id') ?? '',
        args.body,
        args.secrets,
    );
    const known = d.code ? CODE_RECOVERY[d.code] : undefined;
    const recovery: Recovery | undefined =
        known ?? (d.code ? undefined : admissionRecovery(d.status));
    const action = recovery?.action;
    const message = action ? `${describe(d)}. ${action}` : describe(d);
    return siwcError({
        message,
        url: args.url,
        status: args.status,
        retryable: recovery?.retryable ?? (d.status === 429 || d.status >= 500),
        category: recovery?.category,
        friendly: action && withParam(action, d.param),
        responseBody: args.body === undefined ? undefined : JSON.stringify(d),
        responseHeaders: d.requestId
            ? { 'x-request-id': d.requestId }
            : undefined,
    });
}

const withParam = (action: string, param: string) =>
    param ? `${action} (param: ${param})` : action;

/** A terminal stream event other than `response.completed`. */
export function siwcStreamError(args: {
    url: string;
    event: 'response.failed' | 'response.incomplete' | 'error';
    code?: string;
    message?: string;
    param?: string;
    incompleteDetails?: unknown;
    requestId: string;
    secrets: readonly (string | undefined)[];
}): APICallError {
    const code = diagnosticText(args.code ?? '', args.secrets);
    const param = diagnosticText(args.param ?? '', args.secrets);
    let detail = diagnosticText(args.message ?? '', args.secrets);
    if (
        args.incompleteDetails !== undefined &&
        args.incompleteDetails !== null
    ) {
        detail =
            `${detail} ${diagnosticText(JSON.stringify(args.incompleteDetails), args.secrets)}`.trim();
    }
    const known = CODE_RECOVERY[code];
    // An incomplete response is a refusal of this request; any other
    // undocumented stream failure is a server-side failure of this attempt.
    const fallback: Recovery & { status: number } =
        args.event === 'response.incomplete'
            ? {
                  status: 400,
                  category: LlmErrorCategory.REQUEST_REJECTED,
                  retryable: false,
                  action: 'ChatGPT returned an incomplete response.',
              }
            : {
                  status: 500,
                  category: LlmErrorCategory.TRANSIENT,
                  retryable: false,
                  action: 'ChatGPT ended the response with an error.',
              };
    const r = known ?? fallback;
    const d: SiwcDiagnostic = {
        status: r.status,
        code,
        param,
        requestId: diagnosticText(args.requestId, args.secrets),
        shape: 'stream',
        detail,
    };
    const message = `${describe(d)} event=${args.event}. ${r.action}; ${USAGE}`;
    return siwcError({
        message,
        url: args.url,
        status: r.status,
        retryable: r.retryable,
        category: r.category,
        friendly: withParam(r.action, param),
        responseBody: JSON.stringify(d),
    });
}

/** The request to api.openai.com never produced an answer. */
export function siwcTransportError(url: string, cause: unknown): APICallError {
    const reason = cause instanceof Error ? cause.message : String(cause);
    return siwcError({
        message: `ChatGPT API transport failed: ${reason}`,
        url,
        status: 503,
        retryable: true,
        category: LlmErrorCategory.TRANSIENT,
        friendly: 'ChatGPT could not be reached; retry later.',
        cause,
    });
}
