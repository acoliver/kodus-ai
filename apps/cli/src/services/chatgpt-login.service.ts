/**
 * Sign in with ChatGPT: the loopback OAuth flow, run on the admin's machine.
 * Port of OpenCodeReview `internal/chatgptauth/oauth.go` (`authorize`,
 * `callback`, `loginAttempt`, `Login`'s `invalid_grant` restart).
 *
 * The CLI opens the browser, checks the callback, and exchanges the code; it
 * never decodes or trusts the ID token. The Kodus server verifies it (JWKS,
 * nonce, audience, scopes) before any credential becomes usable.
 */
import { createHash, randomBytes } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import open from 'open';

import type { ChatGptTokenResponse } from '../types/chatgpt.js';

export const CHATGPT_ISSUER = 'https://auth.openai.com';
export const CHATGPT_AUTHORIZE_URL = `${CHATGPT_ISSUER}/api/accounts/authorize`;
export const CHATGPT_TOKEN_URL = `${CHATGPT_ISSUER}/api/accounts/oauth/token`;
export const CHATGPT_RESOURCE = 'https://api.openai.com/v1';
export const CHATGPT_SCOPE =
    'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct';
export const DYNAMIC_CLIENT = 'dynamic_agent_client';
export const AGENT_NAME_HINT = 'Kodus';
export const CHATGPT_USAGE_URL = 'https://chatgpt.com/settings/usage';

const LOGIN_TIMEOUT_MS = 10 * 60_000;
const EXCHANGE_TIMEOUT_MS = 30_000;
const CALLBACK_DRAIN_MS = 1_000;
const MAX_TOKEN_BODY = 1 << 20;

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
]);

/** A non-200 token-endpoint answer. The body is never echoed. */
export class ChatGptOAuthError extends Error {
    constructor(
        readonly status: number,
        readonly code: string,
        readonly requestId: string,
    ) {
        super(
            `ChatGPT OAuth request failed: status=${status} code=${code} request_id=${requestId}`,
        );
        this.name = 'ChatGptOAuthError';
    }
}

/** The client and email of a registration this sign-in renews. */
export interface ChatGptRegistrationHint {
    clientId: string;
    email?: string;
}

export interface ChatGptAttempt {
    state: string;
    nonce: string;
    verifier: string;
    redirect: string;
    host: string;
    consent: boolean;
}

export interface ChatGptLoginResult {
    clientId: string;
    nonce: string;
    receivedAt: Date;
    tokenResponse: ChatGptTokenResponse;
}

export interface ChatGptLoginDeps {
    fetch: typeof fetch;
    /** Opens the local start URL; may stay pending while the browser runs. */
    openBrowser: (url: string) => Promise<unknown>;
    out: (line: string) => void;
}

export const defaultChatGptLoginDeps = (
    out: (line: string) => void,
): ChatGptLoginDeps => ({
    fetch: globalThis.fetch,
    openBrowser: (url) => open(url),
    out,
});

/** 32 random bytes, base64url: state, nonce and PKCE verifier. */
export function randomValue(): string {
    return randomBytes(32).toString('base64url');
}

export function buildAuthorizeUrl(
    a: ChatGptAttempt,
    registration?: ChatGptRegistrationHint,
): string {
    const q = new URLSearchParams({
        client_id: registration?.clientId ?? DYNAMIC_CLIENT,
        ext_agent_host_id: a.host,
        response_type: 'code',
        redirect_uri: a.redirect,
        scope: CHATGPT_SCOPE,
        resource: CHATGPT_RESOURCE,
        state: a.state,
        nonce: a.nonce,
        code_challenge_method: 'S256',
        code_challenge: createHash('sha256')
            .update(a.verifier)
            .digest('base64url'),
    });
    if (a.consent) {
        q.set('prompt', 'consent');
    }
    if (!registration) {
        q.set('agent_name_hint', AGENT_NAME_HINT);
    } else if (registration.email) {
        // The retained ID token stays on the server: no id_token_hint.
        q.set('login_hint', registration.email);
    }
    return `${CHATGPT_AUTHORIZE_URL}?${q.toString()}`;
}

type Query = Map<string, string[]>;

/** Parse a query as strictly as Go's `url.ParseQuery`: a `;` separator or a
 *  bad percent-escape is an error, not something to guess around. */
export function parseQueryStrict(raw: string): Query {
    const q: Query = new Map();
    for (const part of raw.split('&')) {
        if (!part) {
            continue;
        }
        if (part.includes(';')) {
            throw new Error('invalid semicolon separator');
        }
        const eq = part.indexOf('=');
        const key = decodeURIComponent(
            (eq < 0 ? part : part.slice(0, eq)).replace(/\+/g, ' '),
        );
        const value = decodeURIComponent(
            (eq < 0 ? '' : part.slice(eq + 1)).replace(/\+/g, ' '),
        );
        q.set(key, [...(q.get(key) ?? []), value]);
    }
    return q;
}

const first = (q: Query, key: string) => q.get(key)?.[0] ?? '';
const count = (q: Query, key: string) => q.get(key)?.length ?? 0;

/** The code and issued client id of a callback, or why it is unusable. */
export function readCallback(
    q: Query,
    a: Pick<ChatGptAttempt, 'state'>,
    registration?: ChatGptRegistrationHint,
): { code: string; clientId: string } {
    for (const key of ['state', 'code', 'client_id', 'error']) {
        if (count(q, key) > 1) {
            throw new Error('duplicate OAuth callback parameter');
        }
    }
    if (!a.state || first(q, 'state') !== a.state) {
        throw new Error('OAuth callback state did not match');
    }
    if (first(q, 'error')) {
        throw new Error('ChatGPT authorization was declined');
    }
    const code = first(q, 'code');
    if (!code) {
        throw new Error('OAuth callback did not include an authorization code');
    }
    let clientId = first(q, 'client_id');
    if (registration) {
        if (clientId && clientId !== registration.clientId) {
            throw new Error('OAuth callback changed the selected client ID');
        }
        clientId = registration.clientId;
    }
    if (!clientId || clientId === DYNAMIC_CLIENT) {
        throw new Error('OAuth registration did not issue a client ID');
    }
    return { code, clientId };
}

/** The fields a usable sign-in response must carry before it is written to
 *  a file or uploaded. Everything else is the server's to check. */
export function assertSignInResponse(t: unknown): ChatGptTokenResponse {
    const r = t as Partial<ChatGptTokenResponse> | null;
    const text = (v: unknown) => typeof v === 'string' && v.length > 0;
    if (
        !r ||
        typeof r !== 'object' ||
        !text(r.access_token) ||
        !text(r.refresh_token) ||
        !text(r.id_token) ||
        typeof r.token_type !== 'string' ||
        r.token_type.toLowerCase() !== 'bearer' ||
        !Number.isInteger(r.expires_in) ||
        (r.expires_in as number) <= 0 ||
        typeof r.scope !== 'string'
    ) {
        throw new Error(
            'ChatGPT sign-in response is missing credentials, Bearer type, expiry, ID token or scopes',
        );
    }
    return r as ChatGptTokenResponse;
}

async function readCapped(response: Response): Promise<string> {
    const text = await response.text();
    if (Buffer.byteLength(text) > MAX_TOKEN_BODY) {
        throw new Error('ChatGPT OAuth response exceeded size limit');
    }
    return text;
}

/** Exchange the authorization code (PKCE). No redirect is followed. */
export async function exchangeCode(
    fetchFn: typeof fetch,
    a: ChatGptAttempt,
    code: string,
    clientId: string,
    signal: AbortSignal,
): Promise<ChatGptTokenResponse> {
    const response = await fetchFn(CHATGPT_TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
            grant_type: 'authorization_code',
            client_id: clientId,
            code,
            code_verifier: a.verifier,
            redirect_uri: a.redirect,
            resource: CHATGPT_RESOURCE,
        }).toString(),
        redirect: 'manual',
        signal: AbortSignal.any([
            signal,
            AbortSignal.timeout(EXCHANGE_TIMEOUT_MS),
        ]),
    });
    const body = await readCapped(response);
    if (response.status !== 200) {
        let code: unknown;
        try {
            code = (JSON.parse(body) as { error?: unknown }).error;
        } catch {
            // A non-JSON error body carries no OAuth code.
        }
        throw new ChatGptOAuthError(
            response.status,
            typeof code === 'string' && KNOWN_OAUTH_CODES.has(code)
                ? code
                : 'unknown_error',
            response.headers.get('x-request-id') ?? '',
        );
    }
    let parsed: unknown;
    try {
        parsed = JSON.parse(body);
    } catch {
        throw new Error('invalid ChatGPT OAuth response JSON');
    }
    return assertSignInResponse(parsed);
}

/** The loopback listener: one request per connection. */
export function createCallbackServer(): http.Server {
    const server = http.createServer();
    server.keepAliveTimeout = 0;
    return server;
}

function plain(res: http.ServerResponse, status: number, text: string): void {
    res.writeHead(status, {
        'Content-Type': 'text/plain; charset=utf-8',
        'Cache-Control': 'no-store',
        'Connection': 'close',
    });
    res.end(text);
}

/**
 * One browser round trip: a loopback listener on 127.0.0.1, a one-time start
 * URL that redirects to OpenAI, the callback check, and the code exchange.
 * `onIssued` receives the issued client id as soon as a callback carries it,
 * so a failed exchange can be retried with it.
 */
export async function loginAttempt(
    args: {
        hostId: string;
        registration?: ChatGptRegistrationHint;
        consent: boolean;
        noBrowser: boolean;
        signal: AbortSignal;
        onIssued: (clientId: string) => void;
    },
    deps: ChatGptLoginDeps,
    createServer: () => http.Server,
): Promise<ChatGptLoginResult> {
    const server = createServer();
    await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => resolve());
    });
    const { port } = server.address() as AddressInfo;
    const listenHost = `127.0.0.1:${port}`;
    const a: ChatGptAttempt = {
        state: randomValue(),
        nonce: randomValue(),
        verifier: randomValue(),
        redirect: `http://${listenHost}/auth/callback`,
        host: args.hostId,
        consent: args.consent,
    };
    const target = buildAuthorizeUrl(a, args.registration);
    const startPath = `/auth/start/${a.state}`;
    let started = false;
    let consumed = false;
    let settle!: (r: { code: string; clientId: string } | Error) => void;
    const callback = new Promise<{ code: string; clientId: string } | Error>(
        (resolve) => (settle = resolve),
    );

    server.on('request', (req, res) => {
        const raw = req.url ?? '';
        const qIndex = raw.indexOf('?');
        const path = qIndex < 0 ? raw : raw.slice(0, qIndex);
        if (path !== startPath && path !== '/auth/callback') {
            plain(res, 404, 'not found');
            return;
        }
        if (req.method !== 'GET' || req.headers.host !== listenHost) {
            plain(res, 403, 'invalid callback origin');
            return;
        }
        if (path === startPath) {
            if (started) {
                plain(res, 410, 'sign-in already started');
                return;
            }
            started = true;
            res.writeHead(302, {
                'Location': target,
                'Cache-Control': 'no-store',
                'Referrer-Policy': 'no-referrer',
                'Connection': 'close',
            });
            res.end();
            return;
        }
        let q: Query;
        try {
            q = parseQueryStrict(qIndex < 0 ? '' : raw.slice(qIndex + 1));
        } catch {
            plain(res, 400, 'invalid OAuth callback state or query');
            return;
        }
        // An unrelated or malformed callback does not consume the attempt.
        if (
            count(q, 'state') !== 1 ||
            first(q, 'state') !== a.state ||
            count(q, 'code') > 1 ||
            count(q, 'client_id') > 1 ||
            count(q, 'error') > 1 ||
            (count(q, 'error') > 0 && count(q, 'code') > 0)
        ) {
            plain(res, 400, 'invalid OAuth callback state or query');
            return;
        }
        let result: { code: string; clientId: string } | Error;
        try {
            result = readCallback(q, a, args.registration);
        } catch (err) {
            if (!first(q, 'error')) {
                plain(res, 400, 'invalid OAuth callback parameters');
                return;
            }
            result = err as Error;
        }
        if (consumed) {
            plain(res, 410, 'callback already consumed');
            return;
        }
        consumed = true;
        settle(result);
        if (result instanceof Error) {
            plain(res, 400, 'Sign-in could not be verified.');
        } else {
            plain(
                res,
                200,
                'Authorization received. Return to the Kodus CLI to confirm sign-in.',
            );
        }
    });

    const aborted = new Promise<never>((_, reject) => {
        const fail = () => reject(args.signal.reason);
        if (args.signal.aborted) {
            fail();
        } else {
            args.signal.addEventListener('abort', fail, { once: true });
        }
    });
    aborted.catch(() => undefined);

    try {
        const localUrl = `http://${listenHost}${startPath}`;
        deps.out(
            'Continue with ChatGPT. Eligible requests use your ChatGPT plan.',
        );
        let browserFailed: Promise<never> = new Promise(() => undefined);
        if (args.noBrowser) {
            deps.out(`Open this local URL in your browser: ${localUrl}`);
        } else {
            // Not awaited: a browser launcher may run until the browser exits.
            browserFailed = Promise.resolve(deps.openBrowser(localUrl)).then(
                () => new Promise<never>(() => undefined),
                () => {
                    throw new Error(
                        'could not open browser; retry with --no-browser',
                    );
                },
            );
            browserFailed.catch(() => undefined);
        }
        const outcome = await Promise.race([callback, aborted, browserFailed]);
        if (outcome instanceof Error) {
            throw outcome;
        }
        args.onIssued(outcome.clientId);
        const tokenResponse = await exchangeCode(
            deps.fetch,
            a,
            outcome.code,
            outcome.clientId,
            args.signal,
        );
        return {
            clientId: outcome.clientId,
            nonce: a.nonce,
            receivedAt: new Date(),
            tokenResponse,
        };
    } finally {
        await closeCallbackServer(server);
    }
}

/**
 * Stop accepting and let an in-flight callback response reach the browser;
 * only connections still open after the drain deadline are cut. `close()`
 * also closes idle connections.
 */
async function closeCallbackServer(server: http.Server): Promise<void> {
    const closed = new Promise<void>((resolve) =>
        server.close(() => resolve()),
    );
    const deadline = setTimeout(
        () => server.closeAllConnections(),
        CALLBACK_DRAIN_MS,
    );
    await closed;
    clearTimeout(deadline);
}

/**
 * The whole sign-in: at most two attempts within ten minutes. When the first
 * code exchange of an attempt that received an issued client id fails with
 * `invalid_grant`, one fresh attempt runs with that client id and new state,
 * nonce and PKCE values; a second failure stops.
 */
export async function runChatGptLogin(
    args: {
        hostId: string;
        registration?: ChatGptRegistrationHint;
        consent: boolean;
        noBrowser: boolean;
        signal?: AbortSignal;
    },
    deps: ChatGptLoginDeps,
): Promise<ChatGptLoginResult> {
    const signal = AbortSignal.any([
        AbortSignal.timeout(LOGIN_TIMEOUT_MS),
        ...(args.signal ? [args.signal] : []),
    ]);
    let registration = args.registration;
    for (let n = 0; ; n++) {
        let issued = '';
        try {
            return await loginAttempt(
                {
                    hostId: args.hostId,
                    registration,
                    consent: args.consent,
                    noBrowser: args.noBrowser,
                    signal,
                    onIssued: (id) => (issued = id),
                },
                deps,
                createCallbackServer,
            );
        } catch (err) {
            if (
                n === 0 &&
                issued &&
                err instanceof ChatGptOAuthError &&
                err.code === 'invalid_grant'
            ) {
                // Keep the issued client only for this pending authorization.
                registration = { clientId: issued };
                continue;
            }
            throw err;
        }
    }
}
