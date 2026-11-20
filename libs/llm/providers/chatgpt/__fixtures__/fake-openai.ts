/**
 * Offline stand-ins for OpenAI's issuer and the session store, shared by the
 * chatgpt specs. Port of OpenCodeReview's `oauthFixture` / `testStore`
 * (`internal/chatgptauth/auth_test.go`).
 */
import { generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import {
    CHATGPT_DISCOVERY_URL,
    CHATGPT_ISSUER,
    CHATGPT_SCOPE,
    CHATGPT_TOKEN_URL,
} from '../constants';
import type { ChatGptSessionStore } from '../session-engine';
import type { ChatGptSessionState } from '../session-state';

export const JWKS_URL = `${CHATGPT_ISSUER}/.well-known/jwks.json`;
export const REVOKE_URL = `${CHATGPT_ISSUER}/oauth/revoke`;

const b64 = (v: string | Buffer) => Buffer.from(v).toString('base64url');

export const json = (body: unknown, status = 200, headers = {}) =>
    new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json', ...headers },
    });

type Handler = (
    url: string,
    init: RequestInit,
) => Response | Promise<Response> | undefined;

/** A fake `auth.openai.com`: discovery, JWKS, token and revocation. */
export class FakeIssuer {
    readonly key: KeyObject;
    readonly publicJwk: Record<string, unknown>;
    claims: Record<string, unknown>;
    tokenCalls = 0;
    discoveries = 0;
    jwksFetches = 0;
    readonly tokenForms: URLSearchParams[] = [];
    readonly revokeForms: URLSearchParams[] = [];
    /** Body for the token endpoint (default: `tokens()`). */
    token?: (form: URLSearchParams) => Response | Record<string, unknown>;
    /** Checked first; return a Response to short-circuit any URL. */
    intercept?: Handler;

    constructor() {
        const { privateKey, publicKey } = generateKeyPairSync('rsa', {
            modulusLength: 2048,
        });
        this.key = privateKey;
        this.publicJwk = {
            ...publicKey.export({ format: 'jwk' }),
            kid: 'key',
            alg: 'RS256',
            use: 'sig',
        };
        const now = Math.floor(Date.now() / 1000);
        this.claims = {
            iss: CHATGPT_ISSUER,
            sub: 'subject',
            aud: 'oaiapp_one',
            exp: now + 3600,
            iat: now,
            nonce: 'nonce',
            email: 'test@example.invalid',
        };
    }

    jwt(
        claims: Record<string, unknown> = this.claims,
        header: Record<string, unknown> = { alg: 'RS256', kid: 'key' },
    ): string {
        const body = `${b64(JSON.stringify(header))}.${b64(JSON.stringify(claims))}`;
        return `${body}.${b64(sign('RSA-SHA256', Buffer.from(body), this.key))}`;
    }

    tokens(): Record<string, unknown> {
        return {
            access_token: 'access-new',
            refresh_token: 'refresh-new',
            id_token: this.jwt(),
            token_type: 'Bearer',
            expires_in: 3600,
            scope: CHATGPT_SCOPE,
        };
    }

    readonly fetch: typeof fetch = async (input, init: RequestInit = {}) => {
        const url = typeof input === 'string' ? input : String(input);
        const intercepted = await this.intercept?.(url, init);
        if (intercepted) return intercepted;
        if (url === CHATGPT_DISCOVERY_URL) {
            this.discoveries++;
            return json({
                issuer: CHATGPT_ISSUER,
                jwks_uri: JWKS_URL,
                revocation_endpoint: REVOKE_URL,
            });
        }
        if (url === JWKS_URL) {
            this.jwksFetches++;
            return json({ keys: [this.publicJwk] });
        }
        if (url === CHATGPT_TOKEN_URL) {
            this.tokenCalls++;
            const form = new URLSearchParams(String(init.body));
            this.tokenForms.push(form);
            const out = this.token ? this.token(form) : this.tokens();
            return out instanceof Response ? out : json(out);
        }
        if (url === REVOKE_URL) {
            this.revokeForms.push(new URLSearchParams(String(init.body)));
            return new Response('', { status: 200 });
        }
        throw new Error(`unexpected request ${url}`);
    };
}

/** A session with plan scopes and an hour of access left. */
export function sessionFixture(
    over: Partial<ChatGptSessionState> = {},
): ChatGptSessionState {
    return {
        uuid: 'row-1',
        organizationId: 'org-1',
        credentialId: 'cred-1',
        revision: 1,
        clientId: 'oaiapp_one',
        issuer: CHATGPT_ISSUER,
        subject: 'subject',
        email: 'test@example.invalid',
        extAgentHostId: 'urn:uuid:00000000-0000-4000-8000-000000000000',
        accessToken: 'access',
        refreshToken: 'refresh',
        idToken: 'id',
        nonce: 'nonce',
        tokenType: 'Bearer',
        scopes: CHATGPT_SCOPE.split(' '),
        expiresAt: new Date(Date.now() + 3600_000),
        welcomed: false,
        ...over,
    };
}

/** In-memory store with real lock and compare-and-swap semantics. */
export class MemoryStore implements ChatGptSessionStore {
    readonly rows = new Map<string, ChatGptSessionState>();
    private readonly locks = new Map<string, Promise<void>>();
    saves = 0;

    put(state: ChatGptSessionState): void {
        this.rows.set(state.credentialId, structuredClone(state));
    }

    get(credentialId: string): ChatGptSessionState | undefined {
        const row = this.rows.get(credentialId);
        return row && structuredClone(row);
    }

    async withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
        const previous = this.locks.get(key) ?? Promise.resolve();
        let release!: () => void;
        const held = new Promise<void>((r) => (release = r));
        const chain = previous.then(() => held);
        this.locks.set(key, chain);
        await previous;
        try {
            return await fn();
        } finally {
            release();
            if (this.locks.get(key) === chain) this.locks.delete(key);
        }
    }

    async load(credentialId: string) {
        return this.get(credentialId);
    }

    async loadByOrganization(organizationId: string) {
        const row = [...this.rows.values()].find(
            (r) => r.organizationId === organizationId,
        );
        return row && structuredClone(row);
    }

    async insert(state: ChatGptSessionState) {
        if (this.rows.has(state.credentialId)) {
            throw new Error('duplicate credential id');
        }
        this.put({ ...state, revision: 1 });
        return this.get(state.credentialId)!;
    }

    async save(next: ChatGptSessionState, expectedRevision: number) {
        const current = this.rows.get(next.credentialId);
        if (!current || current.revision !== expectedRevision) {
            throw new Error('ChatGPT session revision conflict');
        }
        this.saves++;
        this.put({ ...next, revision: expectedRevision + 1 });
        return this.get(next.credentialId)!;
    }

    async delete(uuid: string) {
        for (const [id, row] of this.rows) {
            if (row.uuid === uuid) this.rows.delete(id);
        }
    }
}
