/**
 * Session lifecycle against an in-memory store with real lock and CAS
 * semantics. Ports OpenCodeReview `auth_test.go`, `lifecycle_test.go`,
 * `refresh_recovery_test.go` and `recovery_test.go` store/lifecycle cases.
 */
import {
    getClassification,
    LlmErrorCategory,
} from '@libs/llm/error-classifier';
import { CHATGPT_ISSUER, CHATGPT_SCOPE } from './constants';
import { ChatGptIdTokenVerifier } from './id-token';
import { ChatGptOAuthClient } from './oauth-client';
import {
    ChatGptSessionEngine,
    ChatGptSessionError,
    type ChatGptCredentialBundle,
} from './session-engine';
import type { ChatGptSessionState } from './session-state';
import {
    FakeIssuer,
    JWKS_URL,
    MemoryStore,
    REVOKE_URL,
    json,
    sessionFixture,
} from './__fixtures__/fake-openai';

const HOST = 'urn:uuid:00000000-0000-4000-8000-000000000000';

function engineFor(issuer: FakeIssuer, store: MemoryStore) {
    const oauth = new ChatGptOAuthClient({
        fetch: issuer.fetch,
        sleep: async () => undefined,
    });
    let n = 0;
    return new ChatGptSessionEngine({
        store,
        oauth,
        verifier: new ChatGptIdTokenVerifier(oauth),
        newId: () => `id-${++n}`,
    });
}

function setup(over: Partial<ChatGptSessionState> = {}) {
    const issuer = new FakeIssuer();
    const store = new MemoryStore();
    store.put(sessionFixture(over));
    return { issuer, store, engine: engineFor(issuer, store) };
}

const category = (err: unknown) => getClassification(err)?.category;
const expired = { expiresAt: new Date(Date.now() - 60_000) };

describe('ChatGptSessionEngine.credentials', () => {
    it('returns stored credentials outside the refresh window without a call', async () => {
        const { issuer, engine } = setup();
        const s = await engine.credentials('cred-1');
        expect(s.accessToken).toBe('access');
        expect(issuer.tokenCalls).toBe(0);
    });

    it('eight concurrent callers share one rotation; ID token and grant are kept', async () => {
        const { issuer, store, engine } = setup(expired);
        issuer.token = (form) => {
            expect(form.get('scope')).toBeNull();
            const b = issuer.tokens();
            delete b.id_token;
            delete b.scope;
            return b;
        };
        const results = await Promise.all(
            Array.from({ length: 8 }, () => engine.credentials('cred-1')),
        );
        expect(issuer.tokenCalls).toBe(1);
        for (const r of results) {
            expect(r.refreshToken).toBe('refresh-new');
            expect(r.idToken).toBe('id');
            expect(r.scopes).toEqual(CHATGPT_SCOPE.split(' '));
        }
        expect(store.get('cred-1').refreshToken).toBe('refresh-new');
    });

    it.each(['access_token', 'refresh_token', 'expires_in', 'token_type'])(
        'an incomplete rotation (no %s) keeps the prior tokens',
        async (field) => {
            const { issuer, store, engine } = setup(expired);
            issuer.token = () => {
                const b = issuer.tokens();
                delete b[field];
                return b;
            };
            await expect(engine.credentials('cred-1')).rejects.toThrow();
            expect(store.get('cred-1').refreshToken).toBe('refresh');
        },
    );

    it('a terminal refresh code clears the tokens', async () => {
        const { issuer, store, engine } = setup(expired);
        issuer.token = () => json({ error: 'invalid_grant' }, 400);
        const err = await engine.credentials('cred-1').catch((e) => e);
        expect(category(err)).toBe(LlmErrorCategory.AUTH_INVALID);
        expect(err.message).toContain('kodus chatgpt login');
        const saved = store.get('cred-1');
        expect(saved.accessToken).toBeUndefined();
        expect(saved.refreshToken).toBeUndefined();
        expect(saved.clientId).toBe('oaiapp_one');
    });

    it.each([
        ['invalid_client', 401, LlmErrorCategory.AUTH_INVALID, false],
        ['server_error', 503, LlmErrorCategory.TRANSIENT, true],
        ['temporarily_unavailable', 400, LlmErrorCategory.TRANSIENT, true],
    ])('%s keeps the tokens', async (code, status, cat, retryable) => {
        const { issuer, store, engine } = setup(expired);
        issuer.token = () => json({ error: code }, status);
        const err = await engine.credentials('cred-1').catch((e) => e);
        expect(category(err)).toBe(cat);
        expect(err.isRetryable).toBe(retryable);
        expect(store.get('cred-1').refreshToken).toBe('refresh');
    });

    it.each([
        ['identity', { sub: 'other' }, false],
        ['nonce', { nonce: 'other' }, false],
        ['new-id without nonce', { nonce: undefined }, true],
    ])('refreshed ID token: %s', async (_name, claims, ok) => {
        const { issuer, store, engine } = setup(expired);
        issuer.token = () => ({
            ...issuer.tokens(),
            id_token: issuer.jwt({ ...issuer.claims, ...claims }),
        });
        const result = engine.credentials('cred-1');
        if (ok) {
            await expect(result).resolves.toMatchObject({
                accessToken: 'access-new',
            });
            return;
        }
        const err = await result.catch((e) => e);
        expect(category(err)).toBe(LlmErrorCategory.AUTH_INVALID);
        const saved = store.get('cred-1');
        expect(saved.refreshToken).toBe('refresh');
        expect(saved.identityError).toBeDefined();
        expect(saved.pendingRefresh.response.refresh_token).toBe('refresh-new');
    });

    it('a refreshed grant without the plan scope disables plan use', async () => {
        const { issuer, store, engine } = setup(expired);
        issuer.token = () => ({ ...issuer.tokens(), scope: 'openid email' });
        await expect(engine.credentials('cred-1')).rejects.toThrow(
            '--enable-plan',
        );
        expect(store.get('cred-1').scopes).toEqual(['openid', 'email']);
    });

    it('does not refresh before earliest_refresh_at', async () => {
        const { issuer, engine } = setup({
            expiresAt: new Date(Date.now() + 60_000),
            earliestRefreshAt: new Date(Date.now() + 30_000),
        });
        await engine.credentials('cred-1');
        expect(issuer.tokenCalls).toBe(0);
    });

    it.each([
        ['signed out', { accessToken: undefined }, 'signed out'],
        ['plan disabled', { scopes: ['openid'] }, '--enable-plan'],
        ['identity error', { identityError: 'bad id' }, 'bad id'],
    ])('%s fails with sign-in guidance', async (_n, over, text) => {
        const { engine } = setup(over);
        const err = await engine.credentials('cred-1').catch((e) => e);
        expect(category(err)).toBe(LlmErrorCategory.AUTH_INVALID);
        expect(err.message).toContain(text);
    });

    it('a missing session is an auth failure', async () => {
        const { engine } = setup();
        const err = await engine.credentials('nope').catch((e) => e);
        expect(category(err)).toBe(LlmErrorCategory.AUTH_INVALID);
    });
});

describe('refresh window (verified and pending)', () => {
    const cases = [
        { name: 'outside_window', remaining: 10 * 60_000, calls: 0 },
        { name: 'two_minutes', remaining: 2 * 60_000, calls: 1 },
        { name: 'seconds_remaining', remaining: 15_000, calls: 1 },
        {
            name: 'before_earliest',
            remaining: 2 * 60_000,
            earliest: 60_000,
            calls: 0,
        },
        {
            name: 'after_earliest',
            remaining: 2 * 60_000,
            earliest: -60_000,
            calls: 1,
        },
        {
            name: 'short_lived_replacement',
            remaining: 2 * 60_000,
            calls: 1,
            lifetime: 120,
        },
    ];
    for (const pending of [false, true]) {
        describe(pending ? 'pending' : 'verified', () => {
            it.each(cases)('$name', async (tc) => {
                const issuer = new FakeIssuer();
                const store = new MemoryStore();
                const now = Date.now();
                const expiry = new Date(now + tc.remaining);
                const earliest =
                    tc.earliest !== undefined
                        ? new Date(
                              Math.floor((now + tc.earliest) / 1000) * 1000,
                          )
                        : undefined;
                let s = sessionFixture({
                    expiresAt: expiry,
                    earliestRefreshAt: earliest,
                });
                let wantAccess = 'access';
                let wantRefresh = 'refresh';
                if (pending) {
                    const received = new Date(now - 10 * 60_000);
                    const response = {
                        access_token: 'access-pending',
                        refresh_token: 'refresh-pending',
                        id_token: issuer.jwt({
                            ...issuer.claims,
                            iat: Math.floor(received.getTime() / 1000),
                        }),
                        token_type: 'Bearer',
                        expires_in: Math.floor(
                            (expiry.getTime() - received.getTime()) / 1000,
                        ),
                        ...(earliest && {
                            earliest_refresh_at: earliest.getTime() / 1000,
                        }),
                    };
                    s = sessionFixture({
                        expiresAt: new Date(now - 60_000),
                        pendingRefresh: { response, receivedAt: received },
                    });
                    wantAccess = 'access-pending';
                    wantRefresh = 'refresh-pending';
                }
                store.put(s);
                const pendingExpiry = pending
                    ? new Date(
                          s.pendingRefresh.receivedAt.getTime() +
                              (s.pendingRefresh.response.expires_in as number) *
                                  1000,
                      )
                    : expiry;
                issuer.token = (form) => {
                    expect(form.get('refresh_token')).toBe(wantRefresh);
                    const stored = store.get('cred-1');
                    expect(stored.pendingRefresh).toBeUndefined();
                    expect(stored.accessToken).toBe(wantAccess);
                    expect(stored.expiresAt).toEqual(pendingExpiry);
                    return {
                        ...issuer.tokens(),
                        ...(tc.lifetime && { expires_in: tc.lifetime }),
                    };
                };
                const got = await engineFor(issuer, store).credentials(
                    'cred-1',
                );
                expect(issuer.tokenCalls).toBe(tc.calls);
                if (tc.calls > 0) {
                    wantAccess = 'access-new';
                    wantRefresh = 'refresh-new';
                } else {
                    expect(got.expiresAt).toEqual(pendingExpiry);
                    expect(got.earliestRefreshAt).toEqual(earliest);
                }
                expect(got.accessToken).toBe(wantAccess);
                expect(got.refreshToken).toBe(wantRefresh);
                expect(got.pendingRefresh).toBeUndefined();
                const stored = store.get('cred-1');
                expect(stored.accessToken).toBe(got.accessToken);
                expect(stored.refreshToken).toBe(got.refreshToken);
            });
        });
    }
});

describe('refresh recovery after a verification fault', () => {
    it.each([
        ['healthy_id_token', false],
        ['no_id_token', false],
        ['jwks_unavailable', true],
        ['jwks_missing_key', true],
        ['discovery_unreachable', true],
    ])('%s', async (scenario, needsRecovery) => {
        const issuer = new FakeIssuer();
        const store = new MemoryStore();
        store.put(sessionFixture(expired));
        let recovered = false;
        let refreshCalls = 0;
        let rejectedOld = 0;
        issuer.token = (form) => {
            refreshCalls++;
            if (refreshCalls > 1 && form.get('refresh_token') === 'refresh') {
                rejectedOld++;
                return json({ error: 'invalid_grant' }, 400);
            }
            const t = issuer.tokens();
            if (scenario === 'no_id_token') delete t.id_token;
            return t;
        };
        issuer.intercept = (url) => {
            if (recovered) return undefined;
            if (url === JWKS_URL && scenario === 'jwks_unavailable') {
                return json({ error: 'temporarily_unavailable' }, 503);
            }
            if (url === JWKS_URL && scenario === 'jwks_missing_key') {
                return json({ keys: [] });
            }
            if (
                url.includes('openid') &&
                scenario === 'discovery_unreachable'
            ) {
                throw new TypeError('fetch failed');
            }
            return undefined;
        };
        const first = await engineFor(issuer, store)
            .credentials('cred-1')
            .then(
                (v) => v,
                (e) => e,
            );
        const saved = store.get('cred-1');
        if (needsRecovery) {
            expect(first).toBeInstanceOf(Error);
            expect(category(first)).toBe(LlmErrorCategory.TRANSIENT);
            expect(saved.pendingRefresh.response.refresh_token).toBe(
                'refresh-new',
            );
            expect(saved.accessToken).toBe('access');
        } else {
            expect(first.accessToken).toBe('access-new');
        }
        recovered = true;
        // A fresh engine (process restart): nothing carried in memory.
        const next = await engineFor(issuer, store).credentials('cred-1');
        expect(next.accessToken).toBe('access-new');
        expect(next.pendingRefresh).toBeUndefined();
        expect(refreshCalls).toBe(1);
        expect(rejectedOld).toBe(0);
        if (needsRecovery) {
            expect(next.expiresAt).toEqual(
                new Date(saved.pendingRefresh.receivedAt.getTime() + 3600_000),
            );
        }
    });
});

describe('pending refresh with an unverifiable identity', () => {
    it.each([
        'malformed',
        'signature',
        'subject',
        'nonce',
        'expired_at_receipt',
    ])('%s stops retrying until the user signs in again', async (invalid) => {
        const issuer = new FakeIssuer();
        const store = new MemoryStore();
        const claims = { ...issuer.claims };
        if (invalid === 'subject') claims.sub = 'another-account';
        if (invalid === 'nonce') claims.nonce = 'another-login';
        if (invalid === 'expired_at_receipt') {
            claims.exp = Math.floor(Date.now() / 1000) - 60;
        }
        let id = issuer.jwt(claims);
        if (invalid === 'signature') id += 'invalid';
        if (invalid === 'malformed') id = 'malformed';
        store.put(
            sessionFixture({
                pendingRefresh: {
                    response: { ...issuer.tokens(), id_token: id },
                    receivedAt: new Date(),
                },
            }),
        );
        const engine = engineFor(issuer, store);
        const err = await engine.credentials('cred-1').catch((e) => e);
        expect(category(err)).toBe(LlmErrorCategory.AUTH_INVALID);
        expect(err.message).toContain('kodus chatgpt login');
        expect(issuer.tokenCalls).toBe(0);
        const saved = store.get('cred-1');
        expect(saved.accessToken).toBe('access');
        expect(saved.refreshToken).toBe('refresh');
        expect(saved.identityError).toBeTruthy();

        const offline = new FakeIssuer();
        offline.intercept = () => {
            throw new Error('unexpected network request');
        };
        const again = await engineFor(offline, store)
            .credentials('cred-1')
            .catch((e) => e);
        expect(again.message).toBe(err.message);

        // Signing in again replaces the session and clears the error.
        await engine.importBundle({
            organizationId: 'org-1',
            hostId: HOST,
            replace: false,
            bundle: bundleFor(issuer, {
                newRegistration: false,
                expectedRevision: saved.revision,
            }),
        });
        const restored = await engine.credentials('cred-1');
        expect(restored.accessToken).toBe('access-new');
        expect(restored.pendingRefresh).toBeUndefined();
        expect(restored.identityError).toBeUndefined();
    });

    it('recovers after the ID and access tokens expired, then refreshes again', async () => {
        const issuer = new FakeIssuer();
        const store = new MemoryStore();
        const received = Date.now() - 2 * 60_000;
        const id = issuer.jwt({
            ...issuer.claims,
            iat: Math.floor(received / 1000) - 60,
            exp: Math.floor(received / 1000) + 60,
        });
        store.put(
            sessionFixture({
                pendingRefresh: {
                    response: {
                        access_token: 'expired-access',
                        refresh_token: 'refresh-new',
                        id_token: id,
                        token_type: 'Bearer',
                        expires_in: 60,
                    },
                    receivedAt: new Date(received),
                },
            }),
        );
        issuer.token = (form) => {
            expect(form.get('refresh_token')).toBe('refresh-new');
            const saved = store.get('cred-1');
            expect(saved.pendingRefresh).toBeUndefined();
            expect(saved.expiresAt.getTime()).toBeLessThanOrEqual(Date.now());
            issuer.claims.iat = Math.floor(Date.now() / 1000);
            return issuer.tokens();
        };
        const got = await engineFor(issuer, store).credentials('cred-1');
        expect(got.accessToken).toBe('access-new');
        expect(issuer.tokenCalls).toBe(1);
    });
});

function bundleFor(
    issuer: FakeIssuer,
    over: Partial<ChatGptCredentialBundle> = {},
    tokens: Record<string, unknown> = issuer.tokens(),
): ChatGptCredentialBundle {
    return {
        version: 1,
        issuer: CHATGPT_ISSUER,
        clientId: 'oaiapp_one',
        extAgentHostId: HOST,
        nonce: 'nonce',
        receivedAt: new Date().toISOString(),
        newRegistration: true,
        expectedRevision: null,
        tokenResponse: tokens,
        ...over,
    };
}

describe('ChatGptSessionEngine.importBundle', () => {
    const fresh = () => {
        const issuer = new FakeIssuer();
        const store = new MemoryStore();
        return { issuer, store, engine: engineFor(issuer, store) };
    };
    const run = (
        engine: ChatGptSessionEngine,
        bundle: ChatGptCredentialBundle,
        replace = false,
    ) =>
        engine.importBundle({
            organizationId: 'org-1',
            hostId: HOST,
            replace,
            bundle,
        });

    it('inserts a new registration with a fresh credential id', async () => {
        const { issuer, store, engine } = fresh();
        const r = await run(engine, bundleFor(issuer));
        expect(r.created).toBe(true);
        expect(r.firstPlanUse).toBe(true);
        expect(r.state).toMatchObject({
            organizationId: 'org-1',
            clientId: 'oaiapp_one',
            subject: 'subject',
            email: 'test@example.invalid',
            accessToken: 'access-new',
            revision: 1,
            welcomed: true,
        });
        expect(store.get(r.state.credentialId)).toBeDefined();
    });

    it('stores a grant without the plan scope as plan-disabled', async () => {
        const { issuer, engine } = fresh();
        const r = await run(
            engine,
            bundleFor(
                issuer,
                {},
                { ...issuer.tokens(), scope: 'openid email' },
            ),
        );
        expect(r.firstPlanUse).toBe(false);
        await expect(engine.credentials(r.state.credentialId)).rejects.toThrow(
            '--enable-plan',
        );
    });

    it.each([
        ['wrong host', { extAgentHostId: 'urn:uuid:other' }, 'conflict'],
        [
            'old receipt',
            { receivedAt: new Date(Date.now() - 31 * 86400_000).toISOString() },
            'invalid',
        ],
        [
            'future receipt',
            { receivedAt: new Date(Date.now() + 60_000).toISOString() },
            'invalid',
        ],
        ['dynamic client', { clientId: 'dynamic_agent_client' }, 'invalid'],
        ['wrong issuer', { issuer: 'https://evil.invalid' }, 'invalid'],
        ['wrong nonce', { nonce: 'other' }, 'invalid'],
        [
            'no retained registration',
            { newRegistration: false, expectedRevision: 1 },
            'conflict',
        ],
    ])('refuses %s', async (_n, over, kind) => {
        const { issuer, store, engine } = fresh();
        const err = await run(engine, bundleFor(issuer, over)).catch((e) => e);
        expect(err).toBeInstanceOf(ChatGptSessionError);
        expect(err.kind).toBe(kind);
        expect(store.rows.size).toBe(0);
    });

    it('refuses a bad ID-token signature', async () => {
        const { issuer, engine } = fresh();
        const err = await run(
            engine,
            bundleFor(
                issuer,
                {},
                { ...issuer.tokens(), id_token: `${issuer.jwt()}x` },
            ),
        ).catch((e) => e);
        expect(err.kind).toBe('invalid');
    });

    describe('with a retained registration', () => {
        const retained = () => {
            const ctx = fresh();
            ctx.store.put(sessionFixture({ welcomed: true }));
            return ctx;
        };

        it('re-sign-in updates tokens, keeps the credential and welcome', async () => {
            const { issuer, store, engine } = retained();
            const r = await run(
                engine,
                bundleFor(issuer, {
                    newRegistration: false,
                    expectedRevision: 1,
                }),
            );
            expect(r.state.credentialId).toBe('cred-1');
            expect(r.state.accessToken).toBe('access-new');
            expect(r.firstPlanUse).toBe(false);
            expect(store.get('cred-1').revision).toBe(2);
        });

        it('enable-plan re-sign-in flips plan usage on', async () => {
            const { issuer, store, engine } = retained();
            store.put(
                sessionFixture({ scopes: ['openid', 'resource.invoke'] }),
            );
            const r = await run(
                engine,
                bundleFor(issuer, {
                    newRegistration: false,
                    expectedRevision: 1,
                }),
            );
            expect(r.firstPlanUse).toBe(true);
            await expect(engine.credentials('cred-1')).resolves.toMatchObject({
                accessToken: 'access-new',
            });
        });

        it('refuses a different identity and keeps the session', async () => {
            const { issuer, store, engine } = retained();
            issuer.claims.sub = 'different';
            const err = await run(
                engine,
                bundleFor(issuer, {
                    newRegistration: false,
                    expectedRevision: 1,
                }),
            ).catch((e) => e);
            expect(err.kind).toBe('conflict');
            expect(store.get('cred-1').refreshToken).toBe('refresh');
        });

        it('refuses when the registration changed during sign-in (a refresh committed)', async () => {
            const { issuer, store, engine } = retained();
            store.put(sessionFixture({ ...expired, welcomed: true }));
            issuer.token = () => ({
                access_token: 'access-rotated',
                refresh_token: 'refresh-rotated',
                token_type: 'Bearer',
                expires_in: 3600,
            });
            await engine.credentials('cred-1');
            const err = await run(
                engine,
                bundleFor(issuer, {
                    newRegistration: false,
                    expectedRevision: 1,
                }),
            ).catch((e) => e);
            expect(err.kind).toBe('conflict');
            expect(err.message).toContain('changed during sign-in');
            expect(store.get('cred-1').refreshToken).toBe('refresh-rotated');
        });

        it('refuses a new registration without --replace', async () => {
            const { issuer, store, engine } = retained();
            issuer.claims.aud = 'oaiapp_two';
            const err = await run(
                engine,
                bundleFor(issuer, { clientId: 'oaiapp_two' }),
            ).catch((e) => e);
            expect(err.kind).toBe('conflict');
            expect(store.get('cred-1').clientId).toBe('oaiapp_one');
        });

        it('refuses a new registration that reuses the retained client', async () => {
            const { issuer, engine } = retained();
            const err = await run(engine, bundleFor(issuer), true).catch(
                (e) => e,
            );
            expect(err.kind).toBe('conflict');
            expect(err.message).toContain('already exists');
        });

        it('replace revokes the old session and keeps the credential id', async () => {
            const { issuer, store, engine } = retained();
            issuer.claims = {
                ...issuer.claims,
                aud: 'oaiapp_two',
                sub: 'subject-two',
            };
            const r = await run(
                engine,
                bundleFor(issuer, { clientId: 'oaiapp_two' }),
                true,
            );
            expect(r.replaced).toEqual({ revocationConfirmed: true });
            expect(issuer.revokeForms[0].get('token')).toBe('refresh');
            expect(issuer.revokeForms[0].get('client_id')).toBe('oaiapp_one');
            expect(r.state.credentialId).toBe('cred-1');
            expect(store.get('cred-1')).toMatchObject({
                clientId: 'oaiapp_two',
                subject: 'subject-two',
                accessToken: 'access-new',
            });
        });
    });
});

describe('ChatGptSessionEngine.logout / remove', () => {
    it('revokes, clears tokens and keeps the registration', async () => {
        const { issuer, store, engine } = setup();
        await expect(engine.logout('cred-1')).resolves.toEqual({
            revocationConfirmed: true,
        });
        expect(issuer.revokeForms[0].get('token')).toBe('refresh');
        const saved = store.get('cred-1');
        expect(saved.accessToken).toBeUndefined();
        expect(saved.idToken).toBeUndefined();
        expect(saved.clientId).toBe('oaiapp_one');
        expect(saved.subject).toBe('subject');
    });

    it('revokes the pending refresh token, not the consumed one', async () => {
        const { issuer, store, engine } = setup({
            pendingRefresh: {
                response: { refresh_token: 'pending-refresh' },
                receivedAt: new Date(),
            },
            identityError: 'invalid ID token',
        });
        await engine.logout('cred-1');
        expect(issuer.revokeForms[0].get('token')).toBe('pending-refresh');
        const saved = store.get('cred-1');
        expect(saved.pendingRefresh).toBeUndefined();
        expect(saved.identityError).toBeUndefined();
    });

    it('clears tokens even when revocation is not confirmed', async () => {
        const { issuer, store, engine } = setup();
        issuer.intercept = () => {
            throw new TypeError('network unavailable');
        };
        const r = await engine.logout('cred-1');
        expect(r.revocationConfirmed).toBe(false);
        expect(r.revocationError).toContain('network unavailable');
        expect(store.get('cred-1').accessToken).toBeUndefined();
    });

    it('does not call revocation for a signed-out session', async () => {
        const { issuer, engine } = setup({
            accessToken: undefined,
            refreshToken: undefined,
        });
        await expect(engine.logout('cred-1')).resolves.toEqual({
            revocationConfirmed: true,
        });
        expect(issuer.revokeForms).toHaveLength(0);
    });

    it('a permanent revocation refusal is reported, tokens still cleared', async () => {
        const { issuer, store, engine } = setup();
        issuer.intercept = (url) =>
            url === REVOKE_URL
                ? json({ error: 'invalid_client' }, 400)
                : undefined;
        const r = await engine.logout('cred-1');
        expect(r.revocationConfirmed).toBe(false);
        expect(store.get('cred-1').refreshToken).toBeUndefined();
    });

    it('remove revokes and deletes the row', async () => {
        const { issuer, store, engine } = setup();
        await engine.remove('cred-1');
        expect(issuer.revokeForms).toHaveLength(1);
        expect(store.rows.size).toBe(0);
    });
});
