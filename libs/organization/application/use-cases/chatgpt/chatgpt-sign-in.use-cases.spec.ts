/**
 * The smaller `kodus chatgpt` use cases: status, logout and model choice.
 * Port of OpenCodeReview `chatgpt_auth.go` status/logout and the
 * `chatgpt.go` model selection contract (explicit slugs pass through).
 */
import { NotFoundException } from '@nestjs/common';
import { GetChatGptRegistrationUseCase } from './get-chatgpt-registration.use-case';
import { LogoutChatGptSessionUseCase } from './logout-chatgpt-session.use-case';
import { SetChatGptModelUseCase } from './set-chatgpt-model.use-case';
import { mergeChatGptIntoByok } from './chatgpt-byok.util';

const sessions = (credentialId?: string) => ({
    credentialIdFor: jest.fn(async () => credentialId),
    logout: jest.fn(async () => ({ revocationConfirmed: true })),
    registration: jest.fn(async () =>
        credentialId ? { credentialId, signedIn: true } : undefined,
    ),
});

describe('GetChatGptRegistrationUseCase', () => {
    it('returns the host id and null without a registration', async () => {
        const uc = new GetChatGptRegistrationUseCase(
            sessions() as any,
            { getOrCreate: async () => 'urn:uuid:h' } as any,
        );
        await expect(uc.execute('org-1')).resolves.toEqual({
            hostId: 'urn:uuid:h',
            registration: null,
        });
    });
});

describe('LogoutChatGptSessionUseCase', () => {
    it("logs out the org's session", async () => {
        const s = sessions('cred-chatgpt');
        await expect(
            new LogoutChatGptSessionUseCase(s as any).execute('org-1'),
        ).resolves.toEqual({ revocationConfirmed: true });
        expect(s.logout).toHaveBeenCalledWith('cred-chatgpt');
    });

    it('404 without a registration', async () => {
        await expect(
            new LogoutChatGptSessionUseCase(sessions() as any).execute('org-1'),
        ).rejects.toBeInstanceOf(NotFoundException);
    });
});

describe('SetChatGptModelUseCase', () => {
    const config = {
        version: 2,
        credentials: [
            { id: 'cred-openai', provider: 'openai', apiKey: 'cipher' },
            {
                id: 'cred-chatgpt',
                provider: 'chatgpt',
                settings: { accountEmail: 'a@b.c' },
            },
        ],
        models: [
            { id: 'm1', credentialId: 'cred-openai', model: 'gpt-5' },
            { id: 'm2', credentialId: 'cred-chatgpt', model: 'gpt-6.1-sol' },
        ],
        routing: { defaultModelId: 'm1' },
    };
    const make = (cfg: unknown = config) => {
        const save = {
            execute: jest.fn(
                async (_key: string, _value: unknown, _org: unknown) => true,
            ),
        };
        const uc = new SetChatGptModelUseCase(
            sessions('cred-chatgpt') as any,
            { findByKey: async () => ({ configValue: cfg }) } as any,
            save as any,
        );
        return { uc, save };
    };

    it('changes the slug in place, keeping the model id and routing', async () => {
        const { uc, save } = make();
        await expect(
            uc.execute('org-1', { model: 'any-slug[1m]' }),
        ).resolves.toEqual({ modelId: 'm2', model: 'any-slug[1m]' });
        const saved = save.execute.mock.calls[0][1] as any;
        expect(saved.models[1]).toEqual({
            id: 'm2',
            credentialId: 'cred-chatgpt',
            model: 'any-slug[1m]',
        });
        expect(saved.routing.defaultModelId).toBe('m1');
        expect(saved.credentials[0].apiKey).toBe('');
    });

    it('--set-default routes to it', async () => {
        const { uc, save } = make();
        await uc.execute('org-1', { model: 'gpt-6-luna', setDefault: true });
        expect(
            (save.execute.mock.calls[0][1] as any).routing.defaultModelId,
        ).toBe('m2');
    });

    it('404 when the credential is not in the BYOK config', async () => {
        const { uc } = make({ version: 2, credentials: [], models: [] });
        await expect(
            uc.execute('org-1', { model: 'gpt-6-luna' }),
        ).rejects.toBeInstanceOf(NotFoundException);
    });
});

describe('mergeChatGptIntoByok', () => {
    it('starts a config when there is none and makes the model the default', () => {
        const { config, modelId } = mergeChatGptIntoByok(undefined, {
            credentialId: 'c',
            model: 's',
            setDefault: false,
        });
        expect(config).toEqual({
            version: 2,
            credentials: [{ id: 'c', provider: 'chatgpt', settings: {} }],
            models: [{ id: modelId, credentialId: 'c', model: 's' }],
            routing: { defaultModelId: modelId },
        });
    });
});
