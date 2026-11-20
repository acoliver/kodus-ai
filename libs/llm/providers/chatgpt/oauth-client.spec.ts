/**
 * OAuth client and token-response rules. Ports OpenCodeReview
 * `TestTokenResponseValidation`, `TestOAuthNoRedirects`, `TestHTTPFailureShape`
 * and `TestLogoutRevocationRetriesAndCancellation` (retry half).
 */
import {
    ChatGptOAuthClient,
    isTerminalRefreshError,
    OAuthError,
    OAuthTransportError,
} from './oauth-client';
import { applyTokenResponse, planEnabled, refreshDue } from './session-state';
import {
    CHATGPT_RESOURCE,
    CHATGPT_SCOPE,
    CHATGPT_TOKEN_URL,
} from './constants';
import { FakeIssuer, REVOKE_URL, json } from './__fixtures__/fake-openai';

const now = new Date('2026-11-19T22:00:00Z');
const valid = {
    access_token: 'a',
    refresh_token: 'r',
    id_token: 'i',
    token_type: 'Bearer',
    expires_in: 3600,
    scope: CHATGPT_SCOPE,
};
const empty = { scopes: [] as string[] };

describe('applyTokenResponse', () => {
    it.each<[unknown, boolean]>([
        [Math.floor(now.getTime() / 1000) + 60, true],
        ['2020-01-01T00:00:00Z', true],
        [null, true],
        ['invalid', false],
        [{}, false],
        [999999999999, false],
    ])('earliest_refresh_at %j accepted=%s', (early, ok) => {
        const apply = () =>
            applyTokenResponse(
                empty,
                { ...valid, earliest_refresh_at: early },
                { refresh: false, receivedAt: now },
            );
        if (ok) expect(apply).not.toThrow();
        else expect(apply).toThrow();
    });

    it.each(['access_token', 'refresh_token', 'expires_in', 'token_type'])(
        'rejects a response without %s',
        (field) => {
            const t: Record<string, unknown> = { ...valid };
            delete t[field];
            expect(() =>
                applyTokenResponse(empty, t, {
                    refresh: true,
                    receivedAt: now,
                }),
            ).toThrow('missing credentials');
        },
    );

    it.each([0, 86401, 1.5, '3600'])('rejects expires_in %j', (v) => {
        expect(() =>
            applyTokenResponse(
                empty,
                { ...valid, expires_in: v },
                { refresh: true, receivedAt: now },
            ),
        ).toThrow();
    });

    it('rejects a non-Bearer type and accepts any Bearer casing', () => {
        expect(() =>
            applyTokenResponse(
                empty,
                { ...valid, token_type: 'mac' },
                { refresh: true, receivedAt: now },
            ),
        ).toThrow();
        expect(
            applyTokenResponse(
                empty,
                { ...valid, token_type: 'bearer' },
                { refresh: true, receivedAt: now },
            ).tokenType,
        ).toBe('Bearer');
    });

    it('requires the ID token and scope on sign-in only', () => {
        const { id_token: _i, scope: _s, ...bare } = valid;
        expect(() =>
            applyTokenResponse(empty, bare, {
                refresh: false,
                receivedAt: now,
            }),
        ).toThrow('missing ID token or granted scopes');
        const kept = applyTokenResponse(
            { scopes: ['kept'], idToken: 'old-id' },
            bare,
            { refresh: true, receivedAt: now },
        );
        expect(kept.scopes).toEqual(['kept']);
        expect(kept.idToken).toBe('old-id');
        expect(kept.expiresAt).toEqual(new Date(now.getTime() + 3600_000));
    });
});

describe('planEnabled / refreshDue', () => {
    it('needs both plan scopes', () => {
        expect(planEnabled(CHATGPT_SCOPE.split(' '))).toBe(true);
        expect(planEnabled(['openid', 'resource.invoke'])).toBe(false);
        expect(planEnabled(['chatgpt.tokens.use.direct'])).toBe(false);
    });

    it('is due when expired, or in the 5 minute window after earliest', () => {
        const at = (ms: number) => new Date(now.getTime() + ms);
        expect(refreshDue({ expiresAt: at(-1) }, now)).toBe(true);
        expect(refreshDue({ expiresAt: at(10 * 60_000) }, now)).toBe(false);
        expect(refreshDue({ expiresAt: at(2 * 60_000) }, now)).toBe(true);
        expect(
            refreshDue(
                { expiresAt: at(2 * 60_000), earliestRefreshAt: at(60_000) },
                now,
            ),
        ).toBe(false);
        expect(
            refreshDue(
                { expiresAt: at(2 * 60_000), earliestRefreshAt: at(-60_000) },
                now,
            ),
        ).toBe(true);
    });
});

describe('ChatGptOAuthClient', () => {
    it('sends the refresh form with resource and the issued client, no scope', async () => {
        const issuer = new FakeIssuer();
        const client = new ChatGptOAuthClient({ fetch: issuer.fetch });
        await client.refresh({
            clientId: 'oaiapp_one',
            refreshToken: 'refresh',
        });
        const form = issuer.tokenForms[0];
        expect(Object.fromEntries(form)).toEqual({
            grant_type: 'refresh_token',
            client_id: 'oaiapp_one',
            refresh_token: 'refresh',
            resource: CHATGPT_RESOURCE,
        });
    });

    it.each([
        ['{"error":"invalid_refresh_token"}', 'invalid_refresh_token'],
        ['{"error":"SECRET-ECHO"}', 'unknown_error'],
        ['{"detail":"unavailable"}', 'unknown_error'],
        ['invalid JSON', 'unknown_error'],
    ])('reports %s as code %s without echoing the body', async (body, code) => {
        const client = new ChatGptOAuthClient({
            fetch: async () =>
                new Response(body, {
                    status: 400,
                    headers: { 'x-request-id': 'fixture-request' },
                }),
        });
        const err = await client
            .postForm(CHATGPT_TOKEN_URL, {})
            .catch((e) => e);
        expect(err).toBeInstanceOf(OAuthError);
        expect(err.code).toBe(code);
        expect(err.requestId).toBe('fixture-request');
        expect(err.message).not.toContain('SECRET');
    });

    it('classifies terminal refresh codes', () => {
        expect(
            isTerminalRefreshError(new OAuthError(400, 'invalid_grant', '')),
        ).toBe(true);
        expect(
            isTerminalRefreshError(
                new OAuthError(400, 'refresh_token_reused', ''),
            ),
        ).toBe(true);
        expect(
            isTerminalRefreshError(new OAuthError(401, 'invalid_client', '')),
        ).toBe(false);
        expect(
            isTerminalRefreshError(new OAuthError(503, 'server_error', '')),
        ).toBe(false);
    });

    it('never follows a redirect', async () => {
        let redirect: RequestRedirect | undefined;
        const client = new ChatGptOAuthClient({
            fetch: async (_url, init) => {
                redirect = init?.redirect;
                return new Response('', {
                    status: 302,
                    headers: { location: 'https://evil.invalid' },
                });
            },
        });
        const err = await client
            .postForm(CHATGPT_TOKEN_URL, {})
            .catch((e) => e);
        expect(redirect).toBe('manual');
        expect(err).toBeInstanceOf(OAuthError);
        expect(err.status).toBe(302);
    });

    it('caps the body at 1 MiB', async () => {
        const client = new ChatGptOAuthClient({
            fetch: async () => new Response('x'.repeat((1 << 20) + 1)),
        });
        await expect(client.postForm(CHATGPT_TOKEN_URL, {})).rejects.toThrow(
            'exceeded size limit',
        );
    });

    it('wraps a network failure as a transport error', async () => {
        const client = new ChatGptOAuthClient({
            fetch: async () => {
                throw new TypeError('fetch failed');
            },
        });
        await expect(
            client.postForm(CHATGPT_TOKEN_URL, {}),
        ).rejects.toBeInstanceOf(OAuthTransportError);
    });

    describe('revoke', () => {
        const sleeps: number[] = [];
        const make = (issuer: FakeIssuer) =>
            new ChatGptOAuthClient({
                fetch: issuer.fetch,
                sleep: async (ms) => {
                    sleeps.push(ms);
                },
            });
        beforeEach(() => sleeps.splice(0));

        it('posts token, hint and client to the discovered endpoint', async () => {
            const issuer = new FakeIssuer();
            await make(issuer).revoke({
                clientId: 'oaiapp_one',
                refreshToken: 'refresh',
            });
            expect(Object.fromEntries(issuer.revokeForms[0])).toEqual({
                token: 'refresh',
                token_type_hint: 'refresh_token',
                client_id: 'oaiapp_one',
            });
        });

        it('retries a 5xx with 250 ms × n backoff', async () => {
            const issuer = new FakeIssuer();
            let attempts = 0;
            issuer.intercept = (url) =>
                url === REVOKE_URL && ++attempts < 2
                    ? json({ error: 'server_error' }, 503)
                    : undefined;
            await make(issuer).revoke({
                clientId: 'oaiapp_one',
                refreshToken: 'refresh',
            });
            expect(attempts).toBe(2);
            expect(sleeps).toEqual([250]);
        });

        it('retries a network failure on discovery', async () => {
            const issuer = new FakeIssuer();
            let attempts = 0;
            issuer.intercept = (url) => {
                if (url.includes('openid') && ++attempts < 2) {
                    throw new TypeError('fetch failed');
                }
                return undefined;
            };
            await make(issuer).revoke({
                clientId: 'oaiapp_one',
                refreshToken: 'refresh',
            });
            expect(attempts).toBe(2);
        });

        it('does not retry a 4xx', async () => {
            const issuer = new FakeIssuer();
            let attempts = 0;
            issuer.intercept = (url) => {
                if (url !== REVOKE_URL) return undefined;
                attempts++;
                return json({ error: 'invalid_client' }, 400);
            };
            await expect(
                make(issuer).revoke({
                    clientId: 'oaiapp_one',
                    refreshToken: 'refresh',
                }),
            ).rejects.toBeInstanceOf(OAuthError);
            expect(attempts).toBe(1);
        });

        it('gives up after three attempts', async () => {
            const issuer = new FakeIssuer();
            let attempts = 0;
            issuer.intercept = (url) => {
                if (url !== REVOKE_URL) return undefined;
                attempts++;
                return json({ error: 'server_error' }, 503);
            };
            await expect(
                make(issuer).revoke({
                    clientId: 'oaiapp_one',
                    refreshToken: 'refresh',
                }),
            ).rejects.toBeInstanceOf(OAuthError);
            expect(attempts).toBe(3);
            expect(sleeps).toEqual([250, 500]);
        });
    });
});
