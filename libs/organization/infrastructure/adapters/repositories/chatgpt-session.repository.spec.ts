/**
 * Repository mapping and the compare-and-swap statement. Without a database
 * the statement's shape is what can be checked: one UPDATE keyed on uuid AND
 * revision that increments the revision and writes cleared fields as NULL.
 * OpenCodeReview `TestStoreCorruptionAndLockCancellation` (rows this code
 * could not have written are refused on read) is ported as-is.
 */
import { ChatGptSessionRepository } from './chatgpt-session.repository';
import { sessionFixture } from '@libs/llm/providers/chatgpt/__fixtures__/fake-openai';

const row = (over: Record<string, unknown> = {}) => ({
    ...sessionFixture(),
    email: null,
    nonce: 'nonce',
    accessToken: 'cipher-a',
    refreshToken: 'cipher-r',
    idToken: null,
    tokenType: 'Bearer',
    earliestRefreshAt: null,
    pendingRefresh: null,
    identityError: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...over,
});

function harness(found: unknown, affected = 1) {
    const calls: Record<string, any> = {};
    const qb: any = {
        update: jest.fn(() => qb),
        set: jest.fn((v) => {
            calls.set = v;
            return qb;
        }),
        where: jest.fn((sql, params) => {
            calls.where = { sql, params };
            return qb;
        }),
        execute: jest.fn(async () => ({ affected })),
    };
    const typeorm = {
        findOne: jest.fn(async () => found),
        find: jest.fn(async () => (found ? [found] : [])),
        exists: jest.fn(async () => true),
        createQueryBuilder: jest.fn(() => qb),
    };
    return {
        repo: new ChatGptSessionRepository(typeorm as any),
        typeorm,
        calls,
    };
}

describe('ChatGptSessionRepository', () => {
    it('maps NULL columns to absent values', async () => {
        const { repo } = harness(row());
        const r = await repo.findByCredentialId('cred-1');
        expect(r.email).toBeUndefined();
        expect(r.idToken).toBeUndefined();
        expect(r.accessToken).toBe('cipher-a');
    });

    it.each([
        ['dynamic client', { clientId: 'dynamic_agent_client' }],
        ['empty client', { clientId: '' }],
        ['foreign issuer', { issuer: 'https://evil.invalid' }],
        ['empty subject', { subject: '' }],
    ])('refuses a corrupt row: %s', async (_n, over) => {
        const { repo } = harness(row(over));
        await expect(repo.findByCredentialId('cred-1')).rejects.toThrow(
            'invalid ChatGPT session row',
        );
    });

    it('compare-and-swap is one UPDATE on uuid AND revision that bumps the revision', async () => {
        const { repo, calls } = harness(undefined, 1);
        const {
            uuid: _uuid,
            organizationId: _org,
            credentialId: _cred,
            revision: _rev,
            pendingRefresh: _pending,
            ...patch
        } = sessionFixture({ accessToken: undefined });
        await expect(repo.compareAndSwap('row-1', 4, patch)).resolves.toBe(
            true,
        );
        expect(calls.where).toEqual({
            sql: 'uuid = :uuid AND revision = :expectedRevision',
            params: { uuid: 'row-1', expectedRevision: 4 },
        });
        expect(calls.set.revision()).toBe('revision + 1');
        expect(calls.set.accessToken).toBeNull();
        expect(calls.set).not.toHaveProperty('organizationId');
        expect(calls.set).not.toHaveProperty('credentialId');
    });

    it('compare-and-swap reports a stale revision as false', async () => {
        const { repo } = harness(undefined, 0);
        const {
            uuid: _uuid,
            organizationId: _org,
            credentialId: _cred,
            revision: _rev,
            pendingRefresh: _pending,
            ...patch
        } = sessionFixture();
        await expect(repo.compareAndSwap('row-1', 1, patch)).resolves.toBe(
            false,
        );
    });

    it('existsForOrganization asks for both the org and the credential', async () => {
        const { repo, typeorm } = harness(undefined);
        await repo.existsForOrganization('org-1', 'cred-1');
        expect(typeorm.exists).toHaveBeenCalledWith({
            where: { organizationId: 'org-1', credentialId: 'cred-1' },
        });
    });
});
