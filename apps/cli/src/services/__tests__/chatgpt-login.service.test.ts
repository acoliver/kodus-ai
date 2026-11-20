/**
 * The loopback sign-in. Ports OpenCodeReview `TestAuthorizationAndCallbacks`,
 * `TestLoopbackLogin`, `TestCallbackOneTimeAndWrongMethod`,
 * `TestCallbackMalformedQueryDoesNotExchangeCode`,
 * `TestLoopbackNoBrowserCancellation`, `TestLoginIgnoresUnrelatedCallbacks`,
 * `TestLoginCompletesWhileBrowserOpenerIsRunning`,
 * `TestLoginAcceptsMatchingStateDenial`,
 * `TestInvalidGrantAuthorizationRecovery` and
 * `TestLoginDrainsCallbackResponse`.
 */
import { createHash } from 'node:crypto';
import http from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
    assertSignInResponse,
    buildAuthorizeUrl,
    ChatGptOAuthError,
    CHATGPT_RESOURCE,
    CHATGPT_SCOPE,
    CHATGPT_TOKEN_URL,
    createCallbackServer,
    DYNAMIC_CLIENT,
    loginAttempt,
    parseQueryStrict,
    readCallback,
    runChatGptLogin,
    type ChatGptAttempt,
    type ChatGptLoginDeps,
} from '../chatgpt-login.service.js';

const HOST_ID = 'urn:uuid:00000000-0000-4000-8000-000000000000';

const tokens = () => ({
    access_token: 'access-new',
    refresh_token: 'refresh-new',
    id_token: 'header.payload.signature',
    token_type: 'Bearer',
    expires_in: 3600,
    scope: CHATGPT_SCOPE,
});

/** The browser's first hop: the one-time start URL redirects to OpenAI. */
async function authorization(local: string): Promise<URLSearchParams> {
    const r = await fetch(local, { redirect: 'manual' });
    await r.text();
    return new URL(r.headers.get('location')!).searchParams;
}

async function get(url: string): Promise<{ status: number; body: string }> {
    const r = await fetch(url, { redirect: 'manual' });
    return { status: r.status, body: await r.text() };
}

function sendCallback(q: URLSearchParams, clientId = 'oaiapp_one') {
    const params = new URLSearchParams({
        state: q.get('state')!,
        code: `code-${q.get('state')}`,
        client_id: clientId,
    });
    return get(`${q.get('redirect_uri')}?${params}`);
}

/** A token endpoint that records every exchange form. */
function tokenEndpoint(
    reply: (form: URLSearchParams, n: number) => Response = () =>
        new Response(JSON.stringify(tokens()), { status: 200 }),
) {
    const forms: URLSearchParams[] = [];
    const fetchFn = (async (url: string, init: RequestInit) => {
        expect(url).toBe(CHATGPT_TOKEN_URL);
        expect(init.redirect).toBe('manual');
        const form = new URLSearchParams(String(init.body));
        forms.push(form);
        return reply(form, forms.length);
    }) as unknown as typeof fetch;
    return { forms, fetchFn };
}

function deps(
    openBrowser: ChatGptLoginDeps['openBrowser'],
    fetchFn: typeof fetch,
    lines: string[] = [],
): ChatGptLoginDeps {
    return { fetch: fetchFn, openBrowser, out: (l) => lines.push(l) };
}

const attempt: ChatGptAttempt = {
    state: 'state',
    nonce: 'nonce',
    verifier: 'verifier',
    redirect: 'http://127.0.0.1:123/auth/callback',
    host: HOST_ID,
    consent: false,
};

describe('buildAuthorizeUrl', () => {
    it('new registration: dynamic client, agent name hint, S256 challenge', () => {
        const q = new URL(buildAuthorizeUrl(attempt)).searchParams;
        expect(Object.fromEntries(q)).toEqual({
            client_id: DYNAMIC_CLIENT,
            ext_agent_host_id: HOST_ID,
            response_type: 'code',
            redirect_uri: attempt.redirect,
            scope: CHATGPT_SCOPE,
            resource: CHATGPT_RESOURCE,
            state: 'state',
            nonce: 'nonce',
            code_challenge_method: 'S256',
            code_challenge: createHash('sha256')
                .update('verifier')
                .digest('base64url'),
            agent_name_hint: 'Kodus',
        });
    });

    it('re-sign-in: saved client, login_hint, never agent_name_hint or id_token_hint', () => {
        const q = new URL(
            buildAuthorizeUrl(attempt, {
                clientId: 'oaiapp_one',
                email: 'a@b.c',
            }),
        ).searchParams;
        expect(q.get('client_id')).toBe('oaiapp_one');
        expect(q.get('login_hint')).toBe('a@b.c');
        expect(q.has('agent_name_hint')).toBe(false);
        expect(q.has('id_token_hint')).toBe(false);
        expect(q.has('prompt')).toBe(false);
    });

    it('prompt=consent only when enabling the plan', () => {
        const q = new URL(
            buildAuthorizeUrl(
                { ...attempt, consent: true },
                { clientId: 'oaiapp_one' },
            ),
        ).searchParams;
        expect(q.get('prompt')).toBe('consent');
    });
});

describe('readCallback', () => {
    const old = { clientId: 'oaiapp_one' };
    it.each<[string, typeof old | undefined, boolean]>([
        ['state=state&code=code&client_id=oaiapp_one', undefined, true],
        ['state=state&code=code', undefined, false],
        ['state=wrong&code=code&client_id=oaiapp_one', undefined, false],
        ['state=state&error=access_denied', undefined, false],
        [
            'state=state&code=code&client_id=dynamic_agent_client',
            undefined,
            false,
        ],
        ['state=state&code=code', old, true],
        ['state=state&code=code&client_id=oaiapp_other', old, false],
        ['state=state&state=state&code=code', old, false],
    ])('%s (reauth=%s) ok=%s', (query, registration, ok) => {
        const read = () =>
            readCallback(parseQueryStrict(query), attempt, registration);
        if (ok) {
            expect(read).not.toThrow();
        } else {
            expect(read).toThrow();
        }
    });

    it('keeps the saved client on re-sign-in', () => {
        expect(
            readCallback(parseQueryStrict('state=state&code=c'), attempt, old),
        ).toEqual({ code: 'c', clientId: 'oaiapp_one' });
    });
});

describe('parseQueryStrict', () => {
    it.each(['broken=%zz', 'a=b;c=d'])('rejects %s', (q) => {
        expect(() => parseQueryStrict(q)).toThrow();
    });
});

describe('assertSignInResponse', () => {
    it.each([
        'access_token',
        'refresh_token',
        'id_token',
        'scope',
        'expires_in',
    ])('rejects a response without %s', (field) => {
        const t: Record<string, unknown> = tokens();
        delete t[field];
        expect(() => assertSignInResponse(t)).toThrow();
    });
    it('rejects a non-Bearer token', () => {
        expect(() =>
            assertSignInResponse({ ...tokens(), token_type: 'mac' }),
        ).toThrow();
    });
});

describe('runChatGptLogin', () => {
    it('new registration: loopback redirect, PKCE exchange with the issued client', async () => {
        const { forms, fetchFn } = tokenEndpoint();
        let authorize!: URLSearchParams;
        const result = await runChatGptLogin(
            { hostId: HOST_ID, consent: false, noBrowser: false },
            deps(async (local) => {
                expect(new URL(local).hostname).toBe('127.0.0.1');
                authorize = await authorization(local);
                const redirect = new URL(authorize.get('redirect_uri')!);
                expect(redirect.hostname).toBe('127.0.0.1');
                expect(redirect.pathname).toBe('/auth/callback');
                expect(authorize.get('client_id')).toBe(DYNAMIC_CLIENT);
                expect(authorize.get('ext_agent_host_id')).toBe(HOST_ID);
                await sendCallback(authorize);
            }, fetchFn),
        );
        expect(result.clientId).toBe('oaiapp_one');
        expect(result.nonce).toBe(authorize.get('nonce'));
        expect(result.tokenResponse.refresh_token).toBe('refresh-new');
        expect(forms).toHaveLength(1);
        const form = Object.fromEntries(forms[0]);
        expect(form).toMatchObject({
            grant_type: 'authorization_code',
            client_id: 'oaiapp_one',
            code: `code-${authorize.get('state')}`,
            redirect_uri: authorize.get('redirect_uri'),
            resource: CHATGPT_RESOURCE,
        });
        expect(
            createHash('sha256').update(form.code_verifier).digest('base64url'),
        ).toBe(authorize.get('code_challenge'));
    });

    it('re-sign-in: the saved client id, a callback without client_id', async () => {
        const { forms, fetchFn } = tokenEndpoint();
        const result = await runChatGptLogin(
            {
                hostId: HOST_ID,
                registration: { clientId: 'oaiapp_one', email: 'a@b.c' },
                consent: false,
                noBrowser: false,
            },
            deps(async (local) => {
                const q = await authorization(local);
                expect(q.get('client_id')).toBe('oaiapp_one');
                await get(
                    `${q.get('redirect_uri')}?${new URLSearchParams({ state: q.get('state')!, code: 'c' })}`,
                );
            }, fetchFn),
        );
        expect(result.clientId).toBe('oaiapp_one');
        expect(forms[0].get('client_id')).toBe('oaiapp_one');
    });

    it('serves the start redirect once and refuses other methods and hosts', async () => {
        const { fetchFn } = tokenEndpoint();
        await runChatGptLogin(
            { hostId: HOST_ID, consent: false, noBrowser: false },
            deps(async (local) => {
                const q = await authorization(local);
                expect((await get(local)).status).toBe(410);
                const callback = q.get('redirect_uri')!;
                const post = await fetch(callback, { method: 'POST' });
                expect(post.status).toBe(403);
                const wrongHost = await new Promise<number>(
                    (resolve, reject) => {
                        const u = new URL(callback);
                        http.get(
                            {
                                host: '127.0.0.1',
                                port: u.port,
                                path: `${u.pathname}?state=${q.get('state')}&code=c`,
                                headers: { Host: 'evil.invalid' },
                            },
                            (res) => {
                                res.resume();
                                resolve(res.statusCode!);
                            },
                        ).on('error', reject);
                    },
                );
                expect(wrongHost).toBe(403);
                await sendCallback(q);
                expect((await sendCallback(q)).status).toBe(410);
            }, fetchFn),
        );
    });

    it.each(['&broken=%zz', '&broken=a;b'])(
        'a malformed callback (%s) is refused without exchanging or echoing the code',
        async (suffix) => {
            const { forms, fetchFn } = tokenEndpoint();
            const controller = new AbortController();
            const login = runChatGptLogin(
                {
                    hostId: HOST_ID,
                    consent: false,
                    noBrowser: false,
                    signal: controller.signal,
                },
                deps(async (local) => {
                    const q = await authorization(local);
                    const params = new URLSearchParams({
                        state: q.get('state')!,
                        code: 'sensitive-fixture-code',
                        client_id: 'oaiapp_one',
                    });
                    const r = await get(
                        `${q.get('redirect_uri')}?${params}${suffix}`,
                    );
                    expect(r.status).toBe(400);
                    expect(r.body).not.toContain('sensitive-fixture-code');
                    expect(r.body).not.toContain(q.get('state'));
                    controller.abort();
                }, fetchFn),
            );
            await expect(login).rejects.toBeDefined();
            expect(forms).toHaveLength(0);
        },
    );

    it.each([
        '',
        'state=wrong',
        'state=STATE&state=STATE',
        'state=STATE&broken=%zz',
        'state=STATE',
        'state=STATE&code=code',
        'state=STATE&code=a&code=b',
        'state=STATE&error=denied&error=denied',
        'state=STATE&code=code&error=denied',
        'state=STATE&code=&error=access_denied',
        'state=STATE&code=code&error=&client_id=oaiapp_one',
    ])(
        'ignores the unrelated callback "%s" and completes on the valid one',
        async (query) => {
            const { forms, fetchFn } = tokenEndpoint();
            const result = await runChatGptLogin(
                { hostId: HOST_ID, consent: false, noBrowser: false },
                deps(async (local) => {
                    const q = await authorization(local);
                    const invalid = query.replaceAll('STATE', q.get('state')!);
                    const r = await get(`${q.get('redirect_uri')}?${invalid}`);
                    expect(r.status).toBe(400);
                    await sendCallback(q);
                }, fetchFn),
            );
            expect(result.clientId).toBe('oaiapp_one');
            expect(forms).toHaveLength(1);
        },
    );

    it('completes while the browser opener is still running', async () => {
        const { forms, fetchFn } = tokenEndpoint();
        let release!: () => void;
        const released = new Promise<void>((r) => (release = r));
        let stopped = false;
        const result = await runChatGptLogin(
            { hostId: HOST_ID, consent: false, noBrowser: false },
            deps(async (local) => {
                await sendCallback(await authorization(local));
                await released;
                stopped = true;
            }, fetchFn),
        );
        expect(result.clientId).toBe('oaiapp_one');
        expect(forms).toHaveLength(1);
        expect(stopped).toBe(false);
        release();
    });

    it('a denial with the matching state ends the attempt without an exchange', async () => {
        const { forms, fetchFn } = tokenEndpoint();
        await expect(
            runChatGptLogin(
                { hostId: HOST_ID, consent: false, noBrowser: false },
                deps(async (local) => {
                    const q = await authorization(local);
                    await get(
                        `${q.get('redirect_uri')}?${new URLSearchParams({ state: q.get('state')!, error: 'access_denied' })}`,
                    );
                }, fetchFn),
            ),
        ).rejects.toThrow('ChatGPT authorization was declined');
        expect(forms).toHaveLength(0);
    });

    it('--no-browser prints the local start URL only, and cancels cleanly', async () => {
        const { fetchFn } = tokenEndpoint();
        const lines: string[] = [];
        const controller = new AbortController();
        const out = (line: string) => {
            lines.push(line);
            if (line.includes('http://127.0.0.1:')) {
                controller.abort();
            }
        };
        await expect(
            runChatGptLogin(
                {
                    hostId: HOST_ID,
                    consent: false,
                    noBrowser: true,
                    signal: controller.signal,
                },
                {
                    fetch: fetchFn,
                    openBrowser: async () => {
                        throw new Error('browser must not open');
                    },
                    out,
                },
            ),
        ).rejects.toBeDefined();
        const printed = lines.join('\n');
        expect(printed).toContain('http://127.0.0.1:');
        expect(printed).not.toContain('auth.openai.com');
    });

    it('a browser that cannot be opened points at --no-browser', async () => {
        const { fetchFn } = tokenEndpoint();
        await expect(
            runChatGptLogin(
                { hostId: HOST_ID, consent: false, noBrowser: false },
                deps(async () => {
                    throw new Error('no opener');
                }, fetchFn),
            ),
        ).rejects.toThrow('retry with --no-browser');
    });

    it.each([true, false])(
        'invalid_grant restarts once with the issued client and fresh values (second succeeds: %s)',
        async (succeeds) => {
            const seen: URLSearchParams[] = [];
            const { forms, fetchFn } = tokenEndpoint((form, n) =>
                n === 1 || !succeeds
                    ? new Response('{"error":"invalid_grant"}', { status: 400 })
                    : new Response(JSON.stringify(tokens()), { status: 200 }),
            );
            const login = runChatGptLogin(
                { hostId: HOST_ID, consent: false, noBrowser: false },
                deps(async (local) => {
                    const q = await authorization(local);
                    seen.push(q);
                    await sendCallback(q);
                }, fetchFn),
            );
            if (succeeds) {
                await expect(login).resolves.toMatchObject({
                    clientId: 'oaiapp_one',
                });
            } else {
                const err = await login.catch((e) => e);
                expect(err).toBeInstanceOf(ChatGptOAuthError);
                expect(err.code).toBe('invalid_grant');
            }
            expect(seen).toHaveLength(2);
            expect(forms).toHaveLength(2);
            const [first, second] = seen;
            expect(first.get('client_id')).toBe(DYNAMIC_CLIENT);
            expect(second.get('client_id')).toBe('oaiapp_one');
            expect(second.has('agent_name_hint')).toBe(false);
            for (const key of ['state', 'nonce', 'code_challenge']) {
                expect(second.get(key)).not.toBe(first.get(key));
            }
            expect(second.get('ext_agent_host_id')).toBe(
                first.get('ext_agent_host_id'),
            );
            expect(
                forms.every((f) => f.get('client_id') === 'oaiapp_one'),
            ).toBe(true);
        },
    );

    it('reports a token-endpoint failure by code, without the body', async () => {
        const { fetchFn } = tokenEndpoint(
            () =>
                new Response('{"error":"SECRET-ECHO"}', {
                    status: 400,
                    headers: { 'x-request-id': 'req-1' },
                }),
        );
        const err = await runChatGptLogin(
            { hostId: HOST_ID, consent: false, noBrowser: false },
            deps(async (local) => {
                await sendCallback(await authorization(local));
            }, fetchFn),
        ).catch((e) => e);
        expect(err).toBeInstanceOf(ChatGptOAuthError);
        expect(err.code).toBe('unknown_error');
        expect(err.requestId).toBe('req-1');
        expect(err.message).not.toContain('SECRET');
    });
});

/** A browser request without keep-alive that reads the whole response. */
function browserGet(
    url: string,
): Promise<{ status: number; location?: string; body: string }> {
    return new Promise((resolve, reject) => {
        http.get(url, { agent: false }, (res) => {
            let body = '';
            res.setEncoding('utf8');
            res.on('data', (chunk: string) => (body += chunk));
            res.on('end', () =>
                resolve({
                    status: res.statusCode!,
                    location: res.headers.location,
                    body,
                }),
            );
            res.on('error', reject);
        }).on('error', reject);
    });
}

/**
 * A callback server whose callback response is still in flight when
 * teardown starts: the response is only written once the server begins
 * closing, or never when `stall` is set.
 */
function gatedCallbackServer(stall: boolean) {
    let closing!: () => void;
    const tearingDown = new Promise<void>((resolve) => (closing = resolve));
    const create = () => {
        const server = createCallbackServer();
        // Registered before the login handler, so it sees the response first.
        server.on('request', (req, res) => {
            if (!req.url?.startsWith('/auth/callback')) {
                return;
            }
            const end = res.end.bind(res);
            res.end = ((text: string) => {
                if (!stall) {
                    void tearingDown.then(() => end(text));
                }
                return res;
            }) as unknown as typeof res.end;
        });
        const close = server.close.bind(server);
        server.close = ((done?: (err?: Error) => void) => {
            closing();
            return close(done);
        }) as typeof server.close;
        return server;
    };
    return { create, tearingDown };
}

describe('loginAttempt teardown', () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    const RECEIVED =
        'Authorization received. Return to the Kodus CLI to confirm sign-in.';
    const NOT_VERIFIED = 'Sign-in could not be verified.';

    function run(
        scenario: 'success' | 'denied' | 'exchange failure' | 'canceled',
        stall = false,
    ) {
        const controller = new AbortController();
        const { fetchFn } = tokenEndpoint();
        const exchange =
            scenario === 'exchange failure'
                ? ((async () => {
                      throw new Error('exchange failed');
                  }) as unknown as typeof fetch)
                : scenario === 'canceled'
                  ? ((async () => {
                        controller.abort();
                        throw controller.signal.reason;
                    }) as unknown as typeof fetch)
                  : fetchFn;
        const server = gatedCallbackServer(stall);
        let browser!: Promise<{ status: number; body: string }>;
        const login = loginAttempt(
            {
                hostId: HOST_ID,
                consent: false,
                noBrowser: false,
                signal: controller.signal,
                onIssued: () => undefined,
            },
            deps(async (local) => {
                const start = await browserGet(local);
                const q = new URL(start.location!).searchParams;
                const params = new URLSearchParams({ state: q.get('state')! });
                if (scenario === 'denied') {
                    params.set('error', 'access_denied');
                } else {
                    params.set('code', 'code');
                    params.set('client_id', 'oaiapp_one');
                }
                browser = browserGet(`${q.get('redirect_uri')}?${params}`);
                browser.catch(() => undefined);
            }, exchange),
            server.create,
        );
        login.catch(() => undefined);
        return { login, browser: () => browser, ...server };
    }

    it('success: the browser receives the whole confirmation', async () => {
        const r = run('success');
        await expect(r.login).resolves.toMatchObject({
            clientId: 'oaiapp_one',
        });
        await expect(r.browser()).resolves.toEqual({
            status: 200,
            body: RECEIVED,
            location: undefined,
        });
    });

    it('denied: the browser receives the whole refusal', async () => {
        const r = run('denied');
        await expect(r.login).rejects.toThrow(
            'ChatGPT authorization was declined',
        );
        await expect(r.browser()).resolves.toEqual({
            status: 400,
            body: NOT_VERIFIED,
            location: undefined,
        });
    });

    it('exchange failure: the browser still receives the whole confirmation', async () => {
        const r = run('exchange failure');
        await expect(r.login).rejects.toThrow('exchange failed');
        await expect(r.browser()).resolves.toEqual({
            status: 200,
            body: RECEIVED,
            location: undefined,
        });
    });

    it('canceled: the browser still receives the whole confirmation', async () => {
        const r = run('canceled');
        await expect(r.login).rejects.toMatchObject({ name: 'AbortError' });
        await expect(r.browser()).resolves.toEqual({
            status: 200,
            body: RECEIVED,
            location: undefined,
        });
    });

    it('stalled: teardown force-closes the connection after the 1 s drain deadline', async () => {
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        const r = run('success', true);
        let settled = false;
        void r.login.finally(() => (settled = true));
        await r.tearingDown;
        await vi.advanceTimersByTimeAsync(999);
        expect(settled).toBe(false);
        await vi.advanceTimersByTimeAsync(1);
        await expect(r.login).resolves.toMatchObject({
            clientId: 'oaiapp_one',
        });
        await expect(r.browser()).rejects.toBeInstanceOf(Error);
    });
});
