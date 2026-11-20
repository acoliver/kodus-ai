/**
 * INTEGRATION — ChatGPT session persistence ("Sign in with ChatGPT") against
 * Postgres, with the real repository, host id service, session service and
 * DistributedLockService.
 *
 * The unit specs run these classes over in-memory fakes that model the
 * semantics the design relies on. A fake cannot prove the database provides
 * them, so this checks on the migrated schema that:
 *   1. compareAndSwap is one UPDATE keyed on uuid AND revision: it bumps the
 *      revision once, writes absent values as NULL, and a stale revision
 *      changes nothing;
 *   2. two writers racing from the same revision on separate connections
 *      cannot both win, so a stale write never clobbers a rotated token;
 *   3. rows are scoped to their organization, `credential_id` is unique, the
 *      CHECK refuses unissued client ids and deleting the org removes its row;
 *   4. concurrent first calls to ChatGptHostIdService agree on one urn:uuid v4
 *      and leave one global_parameters row;
 *   5. concurrent ChatGptSessionService.accessToken calls on a due session
 *      refresh once (one token POST), in one service and across two service
 *      instances on separate pools, where only the Postgres advisory lock can
 *      serialize them; the rotation is persisted encrypted, revision +2
 *      (pending write, then rotation), pending_refresh cleared.
 *
 * OpenAI is the FakeIssuer the unit specs use, injected as the service's
 * fetch. Encryption uses the fixed API_CRYPTO_KEY from test/jest.setup.ts.
 * Synthetic organizations only, removed afterwards (sessions cascade).
 *
 * Skips automatically if Postgres isn't reachable or the chatgpt_sessions
 * migration is not applied, matching
 * test/integration/integrations/auth-integration-identity.integration.spec.ts.
 */
require('dotenv').config();

jest.mock('@libs/ee/configs/environment', () => ({
    environment: { API_CLOUD_MODE: false },
}));

import { DataSource } from 'typeorm';
import { v4 as uuidv4 } from 'uuid';

import { decrypt, encrypt } from '@libs/common/utils/crypto';
import { GlobalParametersKey } from '@libs/core/domain/enums/global-parameters-key.enum';
import { ENTITIES } from '@libs/core/infrastructure/database/typeorm/entities';
import { DistributedLockService } from '@libs/core/workflow/infrastructure/distributed-lock.service';
import { FakeIssuer } from '@libs/llm/providers/chatgpt/__fixtures__/fake-openai';
import {
    CHATGPT_ISSUER,
    CHATGPT_SCOPE,
    CHATGPT_TOKEN_URL,
} from '@libs/llm/providers/chatgpt/constants';
import { sessionLockKey } from '@libs/llm/providers/chatgpt/session-engine';
import {
    ChatGptSessionPatch,
    ChatGptSessionRecord,
} from '@libs/organization/domain/chatgpt-session/interfaces/chatgpt-session-record.interface';
import { ChatGptSessionRepository } from '@libs/organization/infrastructure/adapters/repositories/chatgpt-session.repository';
import { ChatGptSessionModel } from '@libs/organization/infrastructure/adapters/repositories/schemas/chatgpt-session.model';
import {
    ChatGptHostIdService,
    isChatGptHostId,
} from '@libs/organization/infrastructure/adapters/services/chatgpt-host-id.service';
import { ChatGptSessionService } from '@libs/organization/infrastructure/adapters/services/chatgpt-session.service';

const PG_HOST = process.env.TEST_PG_HOST ?? 'localhost';
const PG_PORT = parseInt(
    process.env.TEST_PG_PORT ?? process.env.API_PG_DB_PORT ?? '5432',
    10,
);
const PG_USER =
    process.env.TEST_PG_USER ?? process.env.API_PG_DB_USERNAME ?? 'kodusdev';
const PG_PASSWORD =
    process.env.TEST_PG_PASSWORD ??
    process.env.API_PG_DB_PASSWORD ??
    'kodusdev';
const PG_DB =
    process.env.TEST_PG_DB ?? process.env.API_PG_DB_DATABASE ?? 'kodus_db';

const skipIntegration = process.env.SKIP_INTEGRATION === 'true';

const HOST_ID_V4 =
    /^urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const makeDataSource = (poolMax = 4) =>
    new DataSource({
        type: 'postgres',
        host: PG_HOST,
        port: PG_PORT,
        username: PG_USER,
        password: PG_PASSWORD,
        database: PG_DB,
        logging: false,
        synchronize: false,
        entities: ENTITIES,
        extra: { max: poolMax, min: 1, connectionTimeoutMillis: 10_000 },
    });

async function isPostgresReachable(): Promise<boolean> {
    const probe = makeDataSource(1);
    try {
        await probe.initialize();
        await probe.query('SELECT 1 FROM chatgpt_sessions LIMIT 1');
        return true;
    } catch (error) {
        if (process.env.TEST_PG_HOST) {
            // Named on purpose: surface why, instead of a silent skip.
            console.error('Postgres not reachable:', (error as Error)?.message);
        }
        return false;
    } finally {
        if (probe.isInitialized) {
            await probe.destroy();
        }
    }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Poll until `check` holds, failing after `timeoutMs`. */
async function waitFor(
    what: string,
    check: () => Promise<boolean>,
    timeoutMs = 5_000,
): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!(await check())) {
        if (Date.now() > deadline) throw new Error(`timed out: ${what}`);
        await sleep(20);
    }
}

/** A row the repository accepts: issued client, plan scopes, an hour left. */
function sessionRecord(
    organizationId: string,
    over: Partial<ChatGptSessionRecord> = {},
): Omit<ChatGptSessionRecord, 'revision'> {
    return {
        uuid: uuidv4(),
        organizationId,
        credentialId: uuidv4(),
        clientId: 'oaiapp_one',
        issuer: CHATGPT_ISSUER,
        subject: 'subject',
        email: 'test@example.invalid',
        extAgentHostId: 'urn:uuid:00000000-0000-4000-8000-000000000000',
        accessToken: encrypt('access'),
        refreshToken: encrypt('refresh'),
        idToken: encrypt('id'),
        nonce: 'nonce',
        tokenType: 'Bearer',
        scopes: CHATGPT_SCOPE.split(' '),
        expiresAt: new Date(Date.now() + 3600_000),
        welcomed: false,
        ...over,
    };
}

/** The mutable columns of `record`, as compareAndSwap takes them. */
function patchOf(
    record: ChatGptSessionRecord,
    over: Partial<ChatGptSessionPatch> = {},
): ChatGptSessionPatch {
    const {
        uuid: _uuid,
        organizationId: _org,
        credentialId: _cred,
        revision: _rev,
        ...patch
    } = record;
    return { ...patch, ...over };
}

describe('ChatGPT sessions (real Postgres)', () => {
    jest.setTimeout(60_000);

    let reachable = false;
    let dataSource: DataSource;
    let repository: ChatGptSessionRepository;
    const extraDataSources: DataSource[] = [];

    const orgA = uuidv4();
    const orgB = uuidv4();
    const orgs = [orgA, orgB];
    let hostRowCreatedHere = false;

    const repositoryOn = (ds: DataSource) =>
        new ChatGptSessionRepository(ds.getRepository(ChatGptSessionModel));

    const openDataSource = async (poolMax = 4) => {
        const ds = makeDataSource(poolMax);
        await ds.initialize();
        extraDataSources.push(ds);
        return ds;
    };

    const insertOrganization = async (uuid: string) => {
        await dataSource.query(
            `INSERT INTO organizations (uuid, name) VALUES ($1, $2)`,
            [uuid, `test-org-chatgpt-${uuid}`],
        );
    };

    const rawRow = async (uuid: string) =>
        (
            await dataSource.query(
                `SELECT revision, refresh_token, access_token, id_token,
                        pending_refresh, "updatedAt"
                   FROM chatgpt_sessions WHERE uuid = $1`,
                [uuid],
            )
        )[0];

    const hostRows = () =>
        dataSource.query(
            `SELECT "configValue" FROM global_parameters WHERE "configKey" = $1`,
            [GlobalParametersKey.CHATGPT_AGENT_HOST],
        );

    beforeAll(async () => {
        if (skipIntegration) return;
        reachable = await isPostgresReachable();
        if (!reachable) return;

        dataSource = makeDataSource(8);
        await dataSource.initialize();
        repository = repositoryOn(dataSource);
        for (const org of orgs) await insertOrganization(org);
        hostRowCreatedHere = (await hostRows()).length === 0;
    });

    afterAll(async () => {
        for (const ds of extraDataSources) {
            if (ds.isInitialized) await ds.destroy();
        }
        if (!dataSource?.isInitialized) return;
        // chatgpt_sessions rows go with their organization (ON DELETE CASCADE).
        await dataSource.query(
            `DELETE FROM organizations WHERE uuid = ANY($1::uuid[])`,
            [orgs],
        );
        if (hostRowCreatedHere) {
            await dataSource.query(
                `DELETE FROM global_parameters WHERE "configKey" = $1`,
                [GlobalParametersKey.CHATGPT_AGENT_HOST],
            );
        }
        await dataSource.destroy();
    });

    // The skip-when-unreachable pattern would let every case below pass
    // without running. When a database was named on purpose, not reaching it
    // is a failure, not a skip.
    it('reaches the database it was pointed at', () => {
        if (skipIntegration || !process.env.TEST_PG_HOST) return;
        expect(reachable).toBe(true);
    });

    describe('compareAndSwap', () => {
        it('writes at the expected revision and increments it once', async () => {
            if (!reachable) return;
            const inserted = await repository.insert(sessionRecord(orgA));
            expect(inserted.revision).toBe(1);
            const before = await rawRow(inserted.uuid);

            await sleep(20);
            const swapped = await repository.compareAndSwap(
                inserted.uuid,
                1,
                patchOf(inserted, {
                    refreshToken: 'cipher-2',
                    idToken: undefined,
                }),
            );

            expect(swapped).toBe(true);
            const stored = await repository.findByCredentialId(
                inserted.credentialId,
            );
            expect(stored.revision).toBe(2);
            expect(stored.refreshToken).toBe('cipher-2');
            const raw = await rawRow(inserted.uuid);
            // An absent value clears the column instead of keeping the old one.
            expect(raw.id_token).toBeNull();
            expect(new Date(raw.updatedAt).getTime()).toBeGreaterThan(
                new Date(before.updatedAt).getTime(),
            );
        });

        it('returns false and leaves the row unchanged at a stale revision', async () => {
            if (!reachable) return;
            const inserted = await repository.insert(sessionRecord(orgA));
            await expect(
                repository.compareAndSwap(
                    inserted.uuid,
                    1,
                    patchOf(inserted, { refreshToken: 'cipher-2' }),
                ),
            ).resolves.toBe(true);
            const before = await rawRow(inserted.uuid);

            const swapped = await repository.compareAndSwap(
                inserted.uuid,
                1,
                patchOf(inserted, {
                    refreshToken: 'cipher-stale',
                    accessToken: undefined,
                }),
            );

            expect(swapped).toBe(false);
            expect(await rawRow(inserted.uuid)).toEqual(before);
        });

        it('lets exactly one of two racing writers win; the loser cannot clobber the rotation', async () => {
            if (!reachable) return;
            const inserted = await repository.insert(sessionRecord(orgA));
            const writerA = repositoryOn(await openDataSource(1));
            const writerB = repositoryOn(await openDataSource(1));

            // Hold the row so both UPDATEs are in flight against revision 1
            // before either can run: the race is forced, not hoped for.
            const holder = dataSource.createQueryRunner();
            await holder.connect();
            await holder.startTransaction();
            let results: boolean[];
            try {
                await holder.query(
                    `SELECT 1 FROM chatgpt_sessions WHERE uuid = $1 FOR UPDATE`,
                    [inserted.uuid],
                );
                const race = Promise.all([
                    writerA.compareAndSwap(
                        inserted.uuid,
                        1,
                        patchOf(inserted, { refreshToken: 'cipher-from-a' }),
                    ),
                    writerB.compareAndSwap(
                        inserted.uuid,
                        1,
                        patchOf(inserted, { refreshToken: 'cipher-from-b' }),
                    ),
                ]);
                await waitFor('both writers blocked on the row', async () => {
                    const [{ waiting }] = await dataSource.query(
                        `SELECT count(*)::int AS waiting
                           FROM pg_stat_activity
                          WHERE wait_event_type = 'Lock'
                            AND query LIKE 'UPDATE "chatgpt_sessions"%'`,
                    );
                    return waiting === 2;
                });
                await holder.commitTransaction();
                results = await race;
            } finally {
                if (holder.isTransactionActive) {
                    await holder.rollbackTransaction();
                }
                await holder.release();
            }

            expect(results.filter(Boolean)).toHaveLength(1);
            const winner = results[0] ? 'cipher-from-a' : 'cipher-from-b';
            const stored = await repository.findByCredentialId(
                inserted.credentialId,
            );
            expect(stored.revision).toBe(2);
            expect(stored.refreshToken).toBe(winner);
        });
    });

    describe('organization scoping and constraints', () => {
        it('never returns another organization’s row', async () => {
            if (!reachable) return;
            const a = await repository.insert(sessionRecord(orgA));
            const b = await repository.insert(sessionRecord(orgB));
            const service = new ChatGptSessionService(
                repository,
                new DistributedLockService(dataSource),
                new FakeIssuer().fetch,
            );

            await expect(
                repository.existsForOrganization(orgA, a.credentialId),
            ).resolves.toBe(true);
            await expect(
                repository.existsForOrganization(orgA, b.credentialId),
            ).resolves.toBe(false);
            await expect(
                repository.existsForOrganization(orgB, a.credentialId),
            ).resolves.toBe(false);

            const ofA = (await repository.findByOrganizationId(orgA)).map(
                (r) => r.credentialId,
            );
            const ofB = (await repository.findByOrganizationId(orgB)).map(
                (r) => r.credentialId,
            );
            expect(ofA).toContain(a.credentialId);
            expect(ofA).not.toContain(b.credentialId);
            expect(ofB).toEqual([b.credentialId]);

            await expect(
                service.credentialIdFor(orgA, b.credentialId),
            ).resolves.toBeUndefined();
            await expect(
                service.credentialIdFor(orgB, b.credentialId),
            ).resolves.toBe(b.credentialId);
        });

        it('refuses a second row with the same credential_id, even in another org', async () => {
            if (!reachable) return;
            const a = await repository.insert(sessionRecord(orgA));

            await expect(
                repository.insert(
                    sessionRecord(orgB, { credentialId: a.credentialId }),
                ),
            ).rejects.toMatchObject({
                driverError: {
                    code: '23505',
                    constraint: 'UQ_chatgpt_sessions_credential_id',
                },
            });
            await expect(
                repository.existsForOrganization(orgB, a.credentialId),
            ).resolves.toBe(false);
        });

        it.each([
            ['an empty client id', ''],
            ['the dynamic placeholder client', 'dynamic_agent_client'],
        ])('the CHECK constraint refuses %s', async (_name, clientId) => {
            if (!reachable) return;
            const record = sessionRecord(orgA, { clientId });

            await expect(repository.insert(record)).rejects.toMatchObject({
                driverError: {
                    code: '23514',
                    constraint: 'CHK_chatgpt_sessions_issued_client',
                },
            });
            await expect(
                repository.findByCredentialId(record.credentialId),
            ).resolves.toBeUndefined();
        });

        it('deleting the organization deletes its session', async () => {
            if (!reachable) return;
            const orgC = uuidv4();
            orgs.push(orgC);
            await insertOrganization(orgC);
            const c = await repository.insert(sessionRecord(orgC));

            await dataSource.query(
                `DELETE FROM organizations WHERE uuid = $1`,
                [orgC],
            );

            await expect(
                repository.findByCredentialId(c.credentialId),
            ).resolves.toBeUndefined();
            expect(await rawRow(c.uuid)).toBeUndefined();
        });
    });

    describe('ChatGptHostIdService', () => {
        it('concurrent first calls on separate connections agree on one urn:uuid v4', async () => {
            if (!reachable) return;
            const services = await Promise.all(
                Array.from({ length: 5 }, async () => {
                    const ds = await openDataSource(1);
                    return new ChatGptHostIdService(ds);
                }),
            );

            const ids = await Promise.all(services.map((s) => s.getOrCreate()));

            expect(new Set(ids).size).toBe(1);
            expect(ids[0]).toMatch(HOST_ID_V4);
            expect(isChatGptHostId(ids[0])).toBe(true);
            const rows = await hostRows();
            expect(rows).toEqual([{ configValue: { id: ids[0] } }]);

            await sleep(20);
            const later = new ChatGptHostIdService(dataSource);
            await expect(later.getOrCreate()).resolves.toBe(ids[0]);
            expect(await hostRows()).toHaveLength(1);
        });
    });

    describe('refresh serialization', () => {
        /** A due session whose token POST is slow, so concurrent callers
         *  overlap it; the POST records whether the session's advisory lock
         *  was held in Postgres while it ran. */
        async function dueSession() {
            const record = await repository.insert(
                sessionRecord(orgA, {
                    expiresAt: new Date(Date.now() - 60_000),
                }),
            );
            const issuer = new FakeIssuer();
            const lockHeldDuringPost: boolean[] = [];
            const lockId = (
                new DistributedLockService(dataSource) as unknown as {
                    hashKey: (k: string) => [number, number];
                }
            ).hashKey(sessionLockKey(record.credentialId));
            issuer.intercept = async (url) => {
                if (url !== CHATGPT_TOKEN_URL) return undefined;
                const held = await dataSource.query(
                    `SELECT 1 FROM pg_locks
                      WHERE locktype = 'advisory' AND granted
                        AND classid = $1 AND objid = $2`,
                    lockId,
                );
                lockHeldDuringPost.push(held.length === 1);
                await sleep(300);
                return undefined; // fall through to the rotating token reply
            };
            return { record, issuer, lockHeldDuringPost };
        }

        async function expectRotatedOnce(
            record: ChatGptSessionRecord,
            issuer: FakeIssuer,
            lockHeldDuringPost: boolean[],
        ) {
            expect(issuer.tokenCalls).toBe(1);
            expect(issuer.tokenForms[0].get('refresh_token')).toBe('refresh');
            expect(lockHeldDuringPost).toEqual([true]);

            const raw = await rawRow(record.uuid);
            // Pending write, then the rotation.
            expect(raw.revision).toBe(record.revision + 2);
            expect(raw.pending_refresh).toBeNull();
            expect(raw.refresh_token).not.toBe(record.refreshToken);
            expect(raw.refresh_token).not.toContain('refresh-new');
            expect(decrypt(raw.refresh_token)).toBe('refresh-new');
            expect(decrypt(raw.access_token)).toBe('access-new');
        }

        it('one service: concurrent callers share one refresh', async () => {
            if (!reachable) return;
            const { record, issuer, lockHeldDuringPost } = await dueSession();
            const service = new ChatGptSessionService(
                repository,
                new DistributedLockService(dataSource),
                issuer.fetch,
            );

            const tokens = await Promise.all([
                service.accessToken(record.credentialId),
                service.accessToken(record.credentialId),
            ]);

            expect(tokens).toEqual(['access-new', 'access-new']);
            await expectRotatedOnce(record, issuer, lockHeldDuringPost);
        });

        it('two services on separate pools serialize on the advisory lock: one refresh', async () => {
            if (!reachable) return;
            const { record, issuer, lockHeldDuringPost } = await dueSession();
            const lockOutcomes: Array<'acquired' | 'busy'> = [];
            const instance = async () => {
                const ds = await openDataSource(4);
                const locks = new DistributedLockService(ds);
                const acquire = locks.acquire.bind(locks);
                locks.acquire = async (key, options) => {
                    const lock = await acquire(key, options);
                    lockOutcomes.push(lock ? 'acquired' : 'busy');
                    return lock;
                };
                return new ChatGptSessionService(
                    repositoryOn(ds),
                    locks,
                    issuer.fetch,
                );
            };
            const [first, second] = await Promise.all([instance(), instance()]);

            const tokens = await Promise.all([
                first.accessToken(record.credentialId),
                second.accessToken(record.credentialId),
            ]);

            expect(tokens).toEqual(['access-new', 'access-new']);
            await expectRotatedOnce(record, issuer, lockHeldDuringPost);
            // No in-process single flight spans two instances: the second
            // caller found the lock taken in Postgres, then saw the rotation.
            expect(lockOutcomes).toContain('busy');
            expect(lockOutcomes.filter((o) => o === 'acquired')).toHaveLength(
                2,
            );
        });
    });
});
