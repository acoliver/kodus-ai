/**
 * `kodus chatgpt`. Ports OpenCodeReview `TestChatGPTCommandLifecycle`,
 * `TestChatGPTAuthCLIValidation`, `TestChatGPTAuthStatusEmpty`,
 * `TestChatGPTAuthLogoutEmpty`, `TestChatGPTStatusExpiryAfterSignOut` and
 * `TestExplicitPlanConsent` (CLI half).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
    chatGptImportAction,
    chatGptLoginAction,
    chatGptLogoutAction,
    chatGptModelsAction,
    chatGptStatusAction,
    chatGptUseAction,
    createChatGptCommand,
    type ChatGptCommandDeps,
} from '../chatgpt/index.js';
import {
    CHATGPT_ISSUER,
    CHATGPT_SCOPE,
} from '../../services/chatgpt-login.service.js';
import { ApiError } from '../../types/errors.js';
import type { ChatGptRegistration } from '../../types/chatgpt.js';

const HOST = 'urn:uuid:00000000-0000-4000-8000-000000000000';
const tokenResponse = {
    access_token: 'access-secret',
    refresh_token: 'refresh-secret',
    id_token: 'id.token.value',
    token_type: 'Bearer',
    expires_in: 3600,
    scope: CHATGPT_SCOPE,
};

const registration = (
    over: Partial<ChatGptRegistration> = {},
): ChatGptRegistration => ({
    credentialId: 'cred-1',
    clientId: 'oaiapp_one',
    email: 'owner@example.invalid',
    signedIn: true,
    planEnabled: true,
    expiresAt: '2026-11-20T00:00:00.000Z',
    pendingVerification: false,
    revision: 4,
    ...over,
});

type Api = ChatGptCommandDeps['api'];

function setup(reg: ChatGptRegistration | null = null) {
    const lines: string[] = [];
    const files = new Map<string, string>();
    const api = {
        host: vi.fn<Api['host']>(async () => ({ hostId: HOST })),
        registration: vi.fn<Api['registration']>(async () => ({
            hostId: HOST,
            registration: reg,
        })),
        importSession: vi.fn<Api['importSession']>(async () => ({
            credentialId: 'cred-1',
            modelId: 'm1',
            model: 'gpt-6.1-sol',
            models: [{ id: 'gpt-6.1-sol', name: 'Sol' }],
            email: 'owner@example.invalid',
            planEnabled: true,
            firstPlanUse: true,
        })),
        logout: vi.fn<Api['logout']>(async () => ({
            revocationConfirmed: true,
        })),
        setModel: vi.fn<Api['setModel']>(async (_t, b) => ({
            modelId: 'm1',
            model: b.model,
        })),
        listModels: vi.fn<Api['listModels']>(async () => ({
            models: [
                { id: 'gpt-6.1-sol', name: 'Sol' },
                { id: 'gpt-6-luna', name: 'Luna' },
            ],
        })),
        testModel: vi.fn<Api['testModel']>(async () => ({
            ok: true,
            code: 'ok',
            latencyMs: 42,
        })),
    };
    const login = vi.fn<ChatGptCommandDeps['login']>(async () => ({
        clientId: 'oaiapp_one',
        nonce: 'nonce-1',
        receivedAt: new Date('2026-11-19T22:00:00Z'),
        tokenResponse,
    }));
    const deps: ChatGptCommandDeps = {
        api,
        getUserToken: async () => 'user-jwt',
        login,
        loginDeps: () => ({
            fetch,
            openBrowser: async () => {},
            out: () => {},
        }),
        writeFile: async (p, c) => {
            files.set(p, c);
        },
        readFile: async (p) => {
            const c = files.get(p);
            if (c === undefined) {
                throw new Error('ENOENT');
            }
            return c;
        },
        out: (l) => lines.push(l),
    };
    return { deps, api, login, lines, files };
}

describe('kodus chatgpt login', () => {
    it('new registration: signs in, uploads the bundle, tests the connection', async () => {
        const { deps, api, login, lines } = setup();
        await chatGptLoginAction({}, deps);
        expect(login.mock.calls[0][0]).toEqual({
            hostId: HOST,
            registration: undefined,
            consent: false,
            noBrowser: false,
        });
        const body = api.importSession.mock.calls[0][1];
        expect(body.bundle).toEqual({
            version: 1,
            issuer: CHATGPT_ISSUER,
            clientId: 'oaiapp_one',
            extAgentHostId: HOST,
            nonce: 'nonce-1',
            receivedAt: '2026-11-19T22:00:00.000Z',
            newRegistration: true,
            expectedRevision: null,
            tokenResponse,
        });
        expect(api.testModel).toHaveBeenCalledWith('user-jwt', {
            model: 'gpt-6.1-sol',
            credentialId: 'cred-1',
        });
        const printed = lines.join('\n');
        expect(printed).toContain("You're using your ChatGPT plan");
        expect(printed).toContain('Using ChatGPT plan');
        expect(printed).toContain('gpt-6.1-sol\tSol');
        expect(printed).toContain('Connection test ok');
        expect(printed).not.toContain('access-secret');
        expect(printed).not.toContain('refresh-secret');
    });

    it('re-sign-in renews the retained registration with its revision', async () => {
        const { deps, api, login } = setup(registration());
        await chatGptLoginAction({ browser: false }, deps);
        expect(login.mock.calls[0][0]).toMatchObject({
            registration: {
                clientId: 'oaiapp_one',
                email: 'owner@example.invalid',
            },
            noBrowser: true,
        });
        expect(api.importSession.mock.calls[0][1].bundle).toMatchObject({
            newRegistration: false,
            expectedRevision: 4,
        });
    });

    it('--enable-plan asks for consent on the retained registration', async () => {
        const { deps, login } = setup(registration({ planEnabled: false }));
        await chatGptLoginAction({ enablePlan: true }, deps);
        expect(login.mock.calls[0][0].consent).toBe(true);
    });

    it('--enable-plan without a registration, or with --new-account, is refused', async () => {
        const none = setup(null);
        await expect(
            chatGptLoginAction({ enablePlan: true }, none.deps),
        ).rejects.toThrow('requires a retained ChatGPT registration');
        await expect(
            chatGptLoginAction(
                { enablePlan: true, newAccount: true },
                none.deps,
            ),
        ).rejects.toThrow('cannot be combined with --new-account');
        expect(none.login).not.toHaveBeenCalled();
    });

    it('--new-account over an existing registration needs --replace', async () => {
        const { deps, api, login } = setup(registration());
        await expect(
            chatGptLoginAction({ newAccount: true }, deps),
        ).rejects.toThrow('--replace');
        expect(login).not.toHaveBeenCalled();
        await chatGptLoginAction({ newAccount: true, replace: true }, deps);
        expect(api.importSession.mock.calls[0][1]).toMatchObject({
            replace: true,
            bundle: { newRegistration: true, expectedRevision: null },
        });
    });

    it('passes --model and --set-default through unchanged', async () => {
        const { deps, api } = setup();
        await chatGptLoginAction(
            { model: 'unlisted[1m]', setDefault: true },
            deps,
        );
        expect(api.importSession.mock.calls[0][1]).toMatchObject({
            model: 'unlisted[1m]',
            setDefault: true,
        });
    });

    it('a plan-disabled grant says how to enable it and skips the test', async () => {
        const { deps, api, lines } = setup();
        api.importSession.mockResolvedValueOnce({
            credentialId: 'cred-1',
            models: [],
            planEnabled: false,
            firstPlanUse: false,
        });
        await chatGptLoginAction({}, deps);
        expect(lines.join('\n')).toContain('--enable-plan');
        expect(api.testModel).not.toHaveBeenCalled();
    });

    it('a failed connection test fails the command', async () => {
        const { deps, api } = setup();
        api.testModel.mockResolvedValueOnce({
            ok: false,
            code: 'quota_exceeded',
            latencyMs: 3,
            message: 'usage limit',
        });
        await expect(chatGptLoginAction({}, deps)).rejects.toThrow(
            'Connection test failed (quota_exceeded): usage limit',
        );
    });

    it('--output writes a 0600 bundle and uploads nothing; a non-owner may prepare one', async () => {
        const { deps, api, files, lines } = setup();
        api.registration.mockRejectedValueOnce(new ApiError(403, 'forbidden'));
        await chatGptLoginAction({ output: 'bundle.json' }, deps);
        expect(api.importSession).not.toHaveBeenCalled();
        const written = JSON.parse(files.get('bundle.json')!);
        expect(written).toMatchObject({
            newRegistration: true,
            extAgentHostId: HOST,
        });
        expect(lines.join('\n')).toContain('kodus chatgpt import bundle.json');
    });

    it('a 403 on the registration read fails a direct sign-in', async () => {
        const { deps, api } = setup();
        api.registration.mockRejectedValueOnce(new ApiError(403, 'forbidden'));
        await expect(chatGptLoginAction({}, deps)).rejects.toThrow('forbidden');
    });

    it('needs a user login, not a team key', async () => {
        const { deps } = setup();
        deps.getUserToken = async () => null;
        await expect(chatGptLoginAction({}, deps)).rejects.toThrow(
            'kodus auth login',
        );
    });
});

describe('kodus chatgpt import', () => {
    it('uploads a bundle written by --output', async () => {
        const { deps, api, files } = setup();
        files.set(
            'b.json',
            JSON.stringify({ version: 1, clientId: 'oaiapp_one' }),
        );
        await chatGptImportAction('b.json', { model: 'gpt-6-luna' }, deps);
        expect(api.importSession.mock.calls[0][1]).toMatchObject({
            bundle: { version: 1, clientId: 'oaiapp_one' },
            model: 'gpt-6-luna',
        });
    });

    it('reports an unreadable file', async () => {
        const { deps } = setup();
        await expect(
            chatGptImportAction('missing.json', {}, deps),
        ).rejects.toThrow('Could not read a ChatGPT credential bundle');
    });
});

describe('kodus chatgpt status', () => {
    it('empty: not signed in', async () => {
        const { deps, lines } = setup(null);
        await chatGptStatusAction(deps);
        expect(lines.join('\n')).toContain('Not signed in');
    });

    it('signed in: account, plan, expiry, usage link', async () => {
        const { deps, lines } = setup(registration());
        await chatGptStatusAction(deps);
        const printed = lines.join('\n');
        expect(printed).toContain('Account: oaiapp_one');
        expect(printed).toContain('Status: Using ChatGPT plan');
        expect(printed).toContain('Expires: 2026-11-20T00:00:00.000Z');
        expect(printed).toContain('chatgpt.com/settings/usage');
    });

    it('signed out: no expiry line', async () => {
        const { deps, lines } = setup(
            registration({
                signedIn: false,
                planEnabled: false,
                expiresAt: undefined,
            }),
        );
        await chatGptStatusAction(deps);
        const printed = lines.join('\n');
        expect(printed).toContain('Status: signed out');
        expect(printed).not.toContain('Expires:');
    });

    it('plan disabled and identity errors explain the fix', async () => {
        const disabled = setup(registration({ planEnabled: false }));
        await chatGptStatusAction(disabled.deps);
        expect(disabled.lines.join('\n')).toContain('--enable-plan');
        const broken = setup(
            registration({ identityError: 'refresh changed ChatGPT identity' }),
        );
        await chatGptStatusAction(broken.deps);
        expect(broken.lines.join('\n')).toContain('sign-in required');
    });
});

describe('kodus chatgpt logout', () => {
    it('confirmed revocation', async () => {
        const { deps, lines } = setup(registration());
        await chatGptLogoutAction(deps);
        expect(lines.join('\n')).toContain('revoked and tokens cleared');
    });

    it('unconfirmed revocation fails and points at ChatGPT settings', async () => {
        const { deps, api } = setup(registration());
        api.logout.mockResolvedValueOnce({
            revocationConfirmed: false,
            revocationError: 'network',
        });
        await expect(chatGptLogoutAction(deps)).rejects.toThrow(
            'ChatGPT Settings',
        );
    });

    it('no registration is not an error', async () => {
        const { deps, api, lines } = setup(null);
        api.logout.mockRejectedValueOnce(new ApiError(404, 'not found'));
        await chatGptLogoutAction(deps);
        expect(lines.join('\n')).toContain('No ChatGPT registration');
    });
});

describe('kodus chatgpt models / use', () => {
    it('lists slugs and names in server order', async () => {
        const { deps, lines } = setup(registration());
        await chatGptModelsAction(deps);
        expect(lines).toEqual(['gpt-6.1-sol\tSol', 'gpt-6-luna\tLuna']);
    });

    it('use sets the slug unchanged and tests it', async () => {
        const { deps, api } = setup(registration());
        await chatGptUseAction('gpt-6-luna', { setDefault: true }, deps);
        expect(api.setModel).toHaveBeenCalledWith('user-jwt', {
            model: 'gpt-6-luna',
            setDefault: true,
        });
        expect(api.testModel).toHaveBeenCalledWith('user-jwt', {
            model: 'gpt-6-luna',
            credentialId: 'cred-1',
        });
    });
});

describe('command wiring', () => {
    beforeEach(() => vi.restoreAllMocks());

    it('registers the subcommands and login flags', () => {
        const command = createChatGptCommand();
        expect(command.commands.map((c) => c.name()).sort()).toEqual(
            ['import', 'login', 'logout', 'models', 'status', 'use'].sort(),
        );
        const login = command.commands.find((c) => c.name() === 'login')!;
        expect(login.options.map((o) => o.long).sort()).toEqual(
            [
                '--enable-plan',
                '--model',
                '--new-account',
                '--no-browser',
                '--replace',
                '--set-default',
            ].sort(),
        );
    });
});
