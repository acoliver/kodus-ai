/**
 * The server half of `kodus chatgpt login`: bundle import, BYOK merge and
 * compensation. Ports the server side of OpenCodeReview `TestLoopbackLogin`
 * and `TestInvalidGrantAuthorizationRecovery` (a failed sign-in leaves the
 * previous account unchanged), over the real session service.
 */
jest.mock('@libs/ee/configs/environment', () => ({
    environment: { API_CLOUD_MODE: false },
}));

import { ConflictException, BadRequestException } from '@nestjs/common';
import { decrypt, encrypt } from '@libs/common/utils/crypto';
import { OrganizationParametersKey } from '@libs/core/domain/enums';
import {
    CHATGPT_ISSUER,
    CHATGPT_MODELS_URL,
} from '@libs/llm/providers/chatgpt/constants';
import {
    FakeIssuer,
    json,
    sessionFixture,
} from '@libs/llm/providers/chatgpt/__fixtures__/fake-openai';
import type { ChatGptCredentialBundle } from '@libs/llm/providers/chatgpt/session-engine';
import { ChatGptSessionService } from '@libs/organization/infrastructure/adapters/services/chatgpt-session.service';
import {
    FakeChatGptSessionRepository,
    FakeLocks,
} from '@libs/organization/infrastructure/adapters/services/__tests__/chatgpt-session.fakes';
import { ImportChatGptSessionUseCase } from './import-chatgpt-session.use-case';

const HOST = 'urn:uuid:00000000-0000-4000-8000-000000000000';
const ORG = 'org-1';

function setup(existingByok?: unknown) {
    const issuer = new FakeIssuer();
    issuer.intercept = (url) =>
        url === CHATGPT_MODELS_URL
            ? json({
                  models: [
                      {
                          slug: 'gpt-6.1-sol',
                          display_name: 'Sol',
                          visibility: 'list',
                      },
                      {
                          slug: 'gpt-6-luna',
                          display_name: 'Luna',
                          visibility: 'list',
                      },
                  ],
              })
            : undefined;
    const repo = new FakeChatGptSessionRepository();
    const sessions = new ChatGptSessionService(
        repo,
        new FakeLocks() as any,
        issuer.fetch,
    );
    const saved: unknown[] = [];
    const save = {
        execute: jest.fn(async (_key: string, value: unknown) => {
            saved.push(value);
            return true;
        }),
    };
    const orgParams = {
        findByKey: jest.fn(async () =>
            existingByok ? { configValue: existingByok } : null,
        ),
    };
    const useCase = new ImportChatGptSessionUseCase(
        sessions,
        { getOrCreate: async () => HOST } as any,
        orgParams as any,
        save as any,
    );
    return { issuer, repo, useCase, save, saved, sessions };
}

function bundle(
    issuer: FakeIssuer,
    over: Partial<ChatGptCredentialBundle> = {},
    tokens = issuer.tokens(),
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

describe('ImportChatGptSessionUseCase', () => {
    it('stores the session and adds a secret-free credential + first listed model', async () => {
        const { issuer, repo, useCase, saved } = setup();
        const r = await useCase.execute(ORG, { bundle: bundle(issuer) });
        expect(r).toMatchObject({
            model: 'gpt-6.1-sol',
            models: [
                { id: 'gpt-6.1-sol', name: 'Sol' },
                { id: 'gpt-6-luna', name: 'Luna' },
            ],
            email: 'test@example.invalid',
            planEnabled: true,
            firstPlanUse: true,
        });
        const config = saved[0] as any;
        expect(config.credentials).toEqual([
            {
                id: r.credentialId,
                provider: 'chatgpt',
                settings: { accountEmail: 'test@example.invalid' },
            },
        ]);
        expect(config.models).toEqual([
            {
                id: r.modelId,
                credentialId: r.credentialId,
                model: 'gpt-6.1-sol',
            },
        ]);
        expect(config.routing.defaultModelId).toBe(r.modelId);
        expect(JSON.stringify(config)).not.toContain('access-new');
        expect(repo.rows.size).toBe(1);
    });

    it('passes an explicit slug through unchanged, even one not listed', async () => {
        const { issuer, useCase } = setup();
        const r = await useCase.execute(ORG, {
            bundle: bundle(issuer),
            model: 'unlisted-slug',
        });
        expect(r.model).toBe('unlisted-slug');
    });

    it('keeps other credentials as blank resubmits so their ciphertext is kept', async () => {
        const existing = {
            version: 2,
            credentials: [
                {
                    id: 'cred-openai',
                    provider: 'openai',
                    apiKey: encrypt('sk-1'),
                },
                {
                    id: 'cred-bedrock',
                    provider: 'amazon_bedrock',
                    settings: {
                        awsRegion: 'us-east-1',
                        awsBearerToken: encrypt('b'),
                    },
                },
            ],
            models: [{ id: 'm1', credentialId: 'cred-openai', model: 'gpt-5' }],
            routing: { defaultModelId: 'm1' },
        };
        const { issuer, useCase, saved } = setup(existing);
        await useCase.execute(ORG, { bundle: bundle(issuer) });
        const config = saved[0] as any;
        expect(config.credentials[0]).toEqual({
            id: 'cred-openai',
            provider: 'openai',
            apiKey: '',
        });
        expect(config.credentials[1].settings).toEqual({
            awsRegion: 'us-east-1',
            awsBearerToken: '',
        });
        // An existing default is not moved without --set-default.
        expect(config.routing.defaultModelId).toBe('m1');
    });

    it('--set-default moves routing to the ChatGPT model', async () => {
        const existing = {
            version: 2,
            credentials: [
                { id: 'cred-openai', provider: 'openai', apiKey: 'x' },
            ],
            models: [{ id: 'm1', credentialId: 'cred-openai', model: 'gpt-5' }],
            routing: { defaultModelId: 'm1' },
        };
        const { issuer, useCase, saved } = setup(existing);
        const r = await useCase.execute(ORG, {
            bundle: bundle(issuer),
            setDefault: true,
        });
        expect((saved[0] as any).routing.defaultModelId).toBe(r.modelId);
    });

    it('a grant without the plan scope stores the registration, adds no model', async () => {
        const { issuer, useCase, saved } = setup();
        const r = await useCase.execute(ORG, {
            bundle: bundle(
                issuer,
                {},
                { ...issuer.tokens(), scope: 'openid email' },
            ),
        });
        expect(r).toMatchObject({
            planEnabled: false,
            firstPlanUse: false,
            models: [],
        });
        expect(r.model).toBeUndefined();
        expect((saved[0] as any).models).toEqual([]);
        expect((saved[0] as any).credentials).toHaveLength(1);
    });

    it('a host mismatch is a 409 and stores nothing', async () => {
        const { issuer, repo, useCase, save } = setup();
        await expect(
            useCase.execute(ORG, {
                bundle: bundle(issuer, { extAgentHostId: 'urn:uuid:other' }),
            }),
        ).rejects.toBeInstanceOf(ConflictException);
        expect(repo.rows.size).toBe(0);
        expect(save.execute).not.toHaveBeenCalled();
    });

    it('a receipt time outside [now - 30 days, now + 5 s] is a 400', async () => {
        const { issuer, useCase } = setup();
        await expect(
            useCase.execute(ORG, {
                bundle: bundle(issuer, {
                    receivedAt: new Date(
                        Date.now() - 31 * 86400_000,
                    ).toISOString(),
                }),
            }),
        ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('a re-sign-in for another identity is a 409 and the session is unchanged', async () => {
        const { issuer, repo, useCase } = setup();
        repo.rows.set('row-1', {
            ...sessionFixture({ organizationId: ORG }),
            accessToken: encrypt('access'),
            refreshToken: encrypt('refresh'),
            idToken: undefined,
            pendingRefresh: undefined,
        });
        issuer.claims.sub = 'someone-else';
        await expect(
            useCase.execute(ORG, {
                bundle: bundle(issuer, {
                    newRegistration: false,
                    expectedRevision: 1,
                }),
            }),
        ).rejects.toBeInstanceOf(ConflictException);
        expect(decrypt(repo.rows.get('row-1').refreshToken)).toBe('refresh');
    });

    it('replace revokes the previous account and keeps the credential id', async () => {
        const { issuer, repo, useCase } = setup();
        repo.rows.set('row-1', {
            ...sessionFixture({ organizationId: ORG }),
            accessToken: encrypt('access'),
            refreshToken: encrypt('refresh'),
            idToken: undefined,
            pendingRefresh: undefined,
        });
        issuer.claims = { ...issuer.claims, aud: 'oaiapp_two', sub: 'two' };
        const r = await useCase.execute(ORG, {
            bundle: bundle(issuer, { clientId: 'oaiapp_two' }),
            replace: true,
        });
        expect(r.credentialId).toBe('cred-1');
        expect(r.replacedRevocationConfirmed).toBe(true);
        expect(issuer.revokeForms[0].get('token')).toBe('refresh');
    });

    it('compensates a failed BYOK save of a new registration: revoke + delete, original error kept', async () => {
        const { issuer, repo, useCase, save } = setup();
        const failure = new BadRequestException('Invalid BYOK configuration');
        save.execute.mockRejectedValueOnce(failure);
        await expect(
            useCase.execute(ORG, { bundle: bundle(issuer) }),
        ).rejects.toBe(failure);
        expect(repo.rows.size).toBe(0);
        expect(issuer.revokeForms[0].get('token')).toBe('refresh-new');
    });

    it('an empty catalog without --model fails and is compensated', async () => {
        const { issuer, repo, useCase } = setup();
        issuer.intercept = (url) =>
            url === CHATGPT_MODELS_URL ? json({ models: [] }) : undefined;
        await expect(
            useCase.execute(ORG, { bundle: bundle(issuer) }),
        ).rejects.toThrow('--model');
        expect(repo.rows.size).toBe(0);
    });

    it('first plan use is reported once', async () => {
        const { issuer, repo, useCase } = setup();
        const first = await useCase.execute(ORG, { bundle: bundle(issuer) });
        expect(first.firstPlanUse).toBe(true);
        const revision = [...repo.rows.values()][0].revision;
        const again = await useCase.execute(ORG, {
            bundle: bundle(issuer, {
                newRegistration: false,
                expectedRevision: revision,
            }),
        });
        expect(again.firstPlanUse).toBe(false);
    });

    it('saves through the ordinary BYOK path under BYOK_CONFIG', async () => {
        const { issuer, useCase, save } = setup();
        await useCase.execute(ORG, { bundle: bundle(issuer) });
        expect(save.execute).toHaveBeenCalledWith(
            OrganizationParametersKey.BYOK_CONFIG,
            expect.any(Object),
            { organizationId: ORG },
        );
    });
});
