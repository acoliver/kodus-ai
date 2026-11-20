/**
 * The server's half of the ChatGPT OAuth client: discovery, JSON GETs, form
 * POSTs, refresh and revocation against `auth.openai.com`. Port of
 * OpenCodeReview `internal/chatgptauth/oauth.go` (`discover`, `request`,
 * `post`, `revokeSession`). The authorization-code exchange runs in the CLI.
 *
 * Every call refuses redirects, has a timeout and caps the body: the issuer is
 * an external system and its answers are untrusted input.
 */
import { BodyTooLargeError, readBoundedText } from './bounded-body';
import {
    CHATGPT_DISCOVERY_URL,
    CHATGPT_ISSUER,
    CHATGPT_RESOURCE,
    CHATGPT_TOKEN_URL,
    MAX_OAUTH_BODY,
    OAUTH_TIMEOUT_MS,
} from './constants';
import type { TokenResponse } from './session-state';

const KNOWN_OAUTH_CODES = new Set([
    'invalid_request',
    'invalid_client',
    'invalid_grant',
    'invalid_scope',
    'access_denied',
    'unauthorized_client',
    'unsupported_grant_type',
    'server_error',
    'temporarily_unavailable',
    'invalid_refresh_token',
    'token_expired',
    'refresh_token_expired',
    'refresh_token_invalidated',
    'refresh_token_reused',
]);

/** Refresh failures after which the refresh token can never work again. */
const TERMINAL_REFRESH_CODES = new Set([
    'invalid_grant',
    'invalid_refresh_token',
    'token_expired',
    'refresh_token_expired',
    'refresh_token_invalidated',
    'refresh_token_reused',
]);

/** A non-200 answer from the issuer. `code` is the OAuth error code when it is
 *  one of the documented ones, else `unknown_error`: the body is never echoed,
 *  since an unknown field could carry a token. */
export class OAuthError extends Error {
    constructor(
        readonly status: number,
        readonly code: string,
        readonly requestId: string,
    ) {
        super(
            `ChatGPT OAuth request failed: status=${status} code=${code} request_id=${requestId}`,
        );
        this.name = 'OAuthError';
    }
}

/** The request never produced an answer (network failure or timeout). */
export class OAuthTransportError extends Error {
    constructor(cause: unknown) {
        super(
            `ChatGPT OAuth transport failed: ${cause instanceof Error ? cause.message : String(cause)}`,
            { cause },
        );
        this.name = 'OAuthTransportError';
    }
}

export function knownOAuthCode(code: unknown): string {
    return typeof code === 'string' && KNOWN_OAUTH_CODES.has(code)
        ? code
        : 'unknown_error';
}

export function isTerminalRefreshError(err: unknown): boolean {
    return err instanceof OAuthError && TERMINAL_REFRESH_CODES.has(err.code);
}

/** 5xx or no answer at all: the same request may succeed later. */
export function isRetryableOAuthError(err: unknown): boolean {
    return (
        err instanceof OAuthTransportError ||
        (err instanceof OAuthError && err.status >= 500)
    );
}

export interface Discovery {
    issuer: string;
    jwks_uri: string;
    revocation_endpoint: string;
}

export interface ChatGptOAuthClientDeps {
    fetch: typeof fetch;
    /** Backoff between revocation attempts; injectable for tests. */
    sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number) =>
    new Promise<void>((resolve) => setTimeout(resolve, ms));

export class ChatGptOAuthClient {
    private readonly sleep: (ms: number) => Promise<void>;

    constructor(private readonly deps: ChatGptOAuthClientDeps) {
        this.sleep = deps.sleep ?? defaultSleep;
    }

    /** OpenID discovery. The issuer must be OpenAI's exactly, and the JWKS
     *  and revocation endpoints must live on the issuer's own scheme and
     *  host, with no credentials, query or fragment. */
    async discover(): Promise<Discovery> {
        const d = (await this.getJson(CHATGPT_DISCOVERY_URL)) as Record<
            string,
            unknown
        > | null;
        if (
            !d ||
            typeof d !== 'object' ||
            d.issuer !== CHATGPT_ISSUER ||
            !onIssuerHost(d.jwks_uri) ||
            !onIssuerHost(d.revocation_endpoint)
        ) {
            throw new Error(
                'OpenAI discovery endpoints or issuer did not match',
            );
        }
        return {
            issuer: d.issuer,
            jwks_uri: d.jwks_uri as string,
            revocation_endpoint: d.revocation_endpoint as string,
        };
    }

    async getJson(url: string): Promise<unknown> {
        const body = await this.request(url, { method: 'GET' });
        return parseJson(body);
    }

    async postForm(url: string, form: Record<string, string>): Promise<string> {
        return this.request(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams(form).toString(),
        });
    }

    /** Refresh grant. No `scope`: the grant keeps what was consented. */
    async refresh(args: {
        clientId: string;
        refreshToken: string;
    }): Promise<TokenResponse> {
        const body = await this.postForm(CHATGPT_TOKEN_URL, {
            grant_type: 'refresh_token',
            client_id: args.clientId,
            refresh_token: args.refreshToken,
            resource: CHATGPT_RESOURCE,
        });
        const parsed = parseJson(body);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            throw new Error('invalid ChatGPT OAuth response JSON');
        }
        return parsed as TokenResponse;
    }

    /** Revoke a refresh token. Three attempts with 250 ms × n backoff, on 5xx
     *  or transport failures only: a 4xx will not change on retry. */
    async revoke(args: {
        clientId: string;
        refreshToken: string;
    }): Promise<void> {
        let last: unknown;
        for (let n = 0; n < 3; n++) {
            try {
                const d = await this.discover();
                await this.postForm(d.revocation_endpoint, {
                    token: args.refreshToken,
                    token_type_hint: 'refresh_token',
                    client_id: args.clientId,
                });
                return;
            } catch (err) {
                last = err;
                if (!isRetryableOAuthError(err)) throw err;
                if (n < 2) await this.sleep((n + 1) * 250);
            }
        }
        throw last;
    }

    private async request(url: string, init: RequestInit): Promise<string> {
        let response: Response;
        try {
            response = await this.deps.fetch(url, {
                ...init,
                redirect: 'manual',
                signal: AbortSignal.timeout(OAUTH_TIMEOUT_MS),
            });
        } catch (err) {
            throw new OAuthTransportError(err);
        }
        let body: string;
        try {
            body = await readBoundedText(response, MAX_OAUTH_BODY);
        } catch (err) {
            if (err instanceof BodyTooLargeError) {
                throw new Error('ChatGPT OAuth response exceeded size limit', {
                    cause: err,
                });
            }
            throw new OAuthTransportError(err);
        }
        if (response.status !== 200) {
            let code: unknown;
            try {
                code = (JSON.parse(body) as { error?: unknown })?.error;
            } catch {
                // A non-JSON error body carries no OAuth code.
            }
            throw new OAuthError(
                response.status,
                knownOAuthCode(code),
                response.headers.get('x-request-id') ?? '',
            );
        }
        return body;
    }
}

function parseJson(body: string): unknown {
    try {
        return JSON.parse(body);
    } catch {
        throw new Error('invalid ChatGPT OAuth response JSON');
    }
}

function onIssuerHost(endpoint: unknown): boolean {
    if (typeof endpoint !== 'string' || !URL.canParse(endpoint)) return false;
    const u = new URL(endpoint);
    const issuer = new URL(CHATGPT_ISSUER);
    return (
        u.protocol === issuer.protocol &&
        u.host === issuer.host &&
        !u.username &&
        !u.password &&
        !u.hash &&
        !u.search
    );
}
