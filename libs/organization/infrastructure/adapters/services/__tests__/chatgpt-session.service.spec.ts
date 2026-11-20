/**
 * ChatGptSessionService: the deployment's store and token source. Ports the
 * intent of OpenCodeReview `TestCrossProcessSessionLock` (the lock spans
 * processes; here, service instances) plus the design's fast-path, single
 * flight, cloud gate, encryption and reconcile rules.
 */
jest.mock('@libs/ee/configs/environment', () => ({
    environment: { API_CLOUD_MODE: false },
}));

import { environment } from '@libs/ee/configs/environment';
import { encrypt } from '@libs/common/utils/crypto';
import {
    getClassification,
    LlmErrorCategory,
} from '@libs/llm/error-classifier';
import { chatGptTokenSource } from '@libs/llm/providers/chatgpt/token-source';
import {
    FakeIssuer,
    json,
    sessionFixture,
} from '@libs/llm/providers/chatgpt/__fixtures__/fake-openai';
import { CHATGPT_MODELS_URL } from '@libs/llm/providers/chatgpt/constants';
import { ChatGptSessionService } from '../chatgpt-session.service';
import {
    FakeChatGptSessionRepository,
    FakeLocks,
} from './chatgpt-session.fakes';
import type { ChatGptSessionRecord } from '@libs/organization/domain/chatgpt-session/interfaces/chatgpt-session-record.interface';

const setCloud = (on: boolean) => {
    (environment as { API_CLOUD_MODE: boolean }).API_CLOUD_MODE = on;
};

function record(
    over: Partial<ChatGptSessionRecord> = {},
): ChatGptSessionRecord {
    const s = sessionFixture();
    return {
        ...s,
        accessToken: encrypt('access'),
        refreshToken: encrypt('refresh'),
        idToken: encrypt('id'),
        pendingRefresh: undefined,
        ...over,
    };
}

function setup(rows: ChatGptSessionRecord[] = [record()]) {
    const repo = new FakeChatGptSessionRepository();
    for (const r of rows) repo.rows.set(r.uuid, r);
    const locks = new FakeLocks();
    const issuer = new FakeIssuer();
    const make = () =>
        new ChatGptSessionService(repo, locks as any, issuer.fetch);
    return { repo, locks, issuer, service: make(), make };
}

const expiredRow = () => record({ expiresAt: new Date(Date.now() - 60_000) });

describe('ChatGptSessionService', () => {
    afterEach(() => setCloud(false));

    it('wires itself as the provider token source at module init', () => {
        const { service } = setup();
        service.onModuleInit();
        expect(chatGptTokenSource()).toBe(service);
    });

    it('fast path: a usable row is decrypted without taking the lock', async () => {
        const { service, locks, issuer } = setup();
        await expect(service.accessToken('cred-1')).resolves.toBe('access');
        expect(locks.acquires).toBe(0);
        expect(issuer.tokenCalls).toBe(0);
    });

    it('slow path: refreshes under the lock, persists encrypted, then serves', async () => {
        const { service, repo, locks, issuer } = setup([expiredRow()]);
        await expect(service.accessToken('cred-1')).resolves.toBe('access-new');
        expect(locks.acquires).toBe(1);
        expect(issuer.tokenCalls).toBe(1);
        const stored = [...repo.rows.values()][0];
        expect(stored.revision).toBe(3); // pending write, then the rotation
        expect(stored.accessToken).not.toBe('access-new');
        expect(stored.refreshToken).not.toContain('refresh-new');
        expect(stored.pendingRefresh).toBeUndefined();
    });

    it('single flight: concurrent callers in one process share one refresh', async () => {
        const { service, locks, issuer } = setup([expiredRow()]);
        const tokens = await Promise.all(
            Array.from({ length: 8 }, () => service.accessToken('cred-1')),
        );
        expect(new Set(tokens)).toEqual(new Set(['access-new']));
        expect(issuer.tokenCalls).toBe(1);
        expect(locks.acquires).toBe(1);
    });

    it('two service instances (processes) serialize on the lock: one refresh', async () => {
        const { make, issuer } = setup([expiredRow()]);
        const a = make();
        const b = make();
        const [x, y] = await Promise.all([
            a.accessToken('cred-1'),
            b.accessToken('cred-1'),
        ]);
        expect(x).toBe('access-new');
        expect(y).toBe('access-new');
        expect(issuer.tokenCalls).toBe(1);
    });

    it('a pending refresh is stored encrypted and recovered after a JWKS outage', async () => {
        const { service, repo, issuer } = setup([expiredRow()]);
        let outage = true;
        issuer.intercept = (url) =>
            outage && url.endsWith('/jwks.json')
                ? json({ error: 'temporarily_unavailable' }, 503)
                : undefined;
        await expect(service.accessToken('cred-1')).rejects.toThrow(
            'verification is unavailable',
        );
        const pending = [...repo.rows.values()][0].pendingRefresh;
        expect(pending).toBeDefined();
        expect(pending).not.toContain('refresh-new');
        outage = false;
        await expect(service.accessToken('cred-1')).resolves.toBe('access-new');
        expect(issuer.tokenCalls).toBe(1);
    });

    it('gives up waiting for a held lock after the deadline, as a transient error', async () => {
        jest.useFakeTimers();
        try {
            const { service, locks } = setup([expiredRow()]);
            locks.contended = true;
            const pending = service.accessToken('cred-1').catch((e) => e);
            await jest.advanceTimersByTimeAsync(61_000);
            const err = await pending;
            expect(err.message).toContain('ChatGPT session is busy');
            expect(getClassification(err)?.category).toBe(
                LlmErrorCategory.TRANSIENT,
            );
            expect(err.isRetryable).toBe(true);
        } finally {
            jest.useRealTimers();
        }
    });

    it('a CAS miss inside the lock throws and serves no token', async () => {
        const { service, repo } = setup([expiredRow()]);
        repo.compareAndSwap = async () => false;
        await expect(service.accessToken('cred-1')).rejects.toThrow(
            'changed while locked',
        );
    });

    it('refuses every token on Kodus Cloud, even with a stored row', async () => {
        setCloud(true);
        const { service, repo } = setup();
        const err = await service.accessToken('cred-1').catch((e) => e);
        expect(getClassification(err)?.category).toBe(
            LlmErrorCategory.CONFIG_INVALID,
        );
        expect(repo.reads).toBe(0);
    });

    it('round-trips tokens through encryption (import then serve)', async () => {
        const { service, issuer, repo } = setup([]);
        const r = await service.importBundle({
            organizationId: 'org-9',
            hostId: 'urn:uuid:00000000-0000-4000-8000-000000000000',
            replace: false,
            bundle: {
                version: 1,
                issuer: 'https://auth.openai.com',
                clientId: 'oaiapp_one',
                extAgentHostId: 'urn:uuid:00000000-0000-4000-8000-000000000000',
                nonce: 'nonce',
                receivedAt: new Date().toISOString(),
                newRegistration: true,
                expectedRevision: null,
                tokenResponse: issuer.tokens(),
            },
        });
        const stored = [...repo.rows.values()][0];
        expect(stored.accessToken).not.toBe('access-new');
        expect(stored.idToken).not.toContain('eyJ');
        await expect(service.accessToken(r.state.credentialId)).resolves.toBe(
            'access-new',
        );
    });

    it('lists the catalog with the session token', async () => {
        const { service, issuer } = setup();
        let auth: string | undefined;
        issuer.intercept = (url, init) => {
            if (url !== CHATGPT_MODELS_URL) return undefined;
            auth = (init.headers as Record<string, string>).Authorization;
            return json({
                models: [
                    {
                        slug: 'gpt-6.1-sol',
                        display_name: 'Sol',
                        visibility: 'list',
                    },
                ],
            });
        };
        await expect(service.listModels('cred-1')).resolves.toMatchObject([
            { id: 'gpt-6.1-sol', name: 'Sol' },
        ]);
        expect(auth).toBe('Bearer access');
    });

    it('credentialIdFor only resolves the caller org own sessions', async () => {
        const { service } = setup([
            record(),
            record({
                uuid: 'row-2',
                organizationId: 'org-2',
                credentialId: 'cred-2',
            }),
        ]);
        await expect(service.credentialIdFor('org-1', 'cred-1')).resolves.toBe(
            'cred-1',
        );
        await expect(
            service.credentialIdFor('org-1', 'cred-2'),
        ).resolves.toBeUndefined();
        await expect(service.credentialIdFor('org-2')).resolves.toBe('cred-2');
        await expect(service.credentialIdFor('org-3')).resolves.toBeUndefined();
    });

    it('registration summary never carries a token', async () => {
        const { service } = setup();
        const summary = await service.registration('org-1');
        expect(summary).toMatchObject({
            credentialId: 'cred-1',
            clientId: 'oaiapp_one',
            signedIn: true,
            planEnabled: true,
            pendingVerification: false,
            revision: 1,
        });
        expect(JSON.stringify(summary)).not.toMatch(/access|refresh|"id"/);
    });

    it('reconcile revokes and deletes only orphaned sessions', async () => {
        const { service, repo, issuer } = setup([
            record(),
            record({
                uuid: 'row-2',
                organizationId: 'org-2',
                credentialId: 'cred-2',
            }),
        ]);
        await service.reconcile('org-1', []);
        expect(issuer.revokeForms).toHaveLength(1);
        expect(issuer.revokeForms[0].get('token')).toBe('refresh');
        expect([...repo.rows.values()].map((r) => r.credentialId)).toEqual([
            'cred-2',
        ]);
        await service.reconcile('org-2', ['cred-2']);
        expect(repo.rows.size).toBe(1);
    });
});
