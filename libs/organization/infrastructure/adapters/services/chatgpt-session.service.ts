import { Inject, Injectable, OnModuleInit } from '@nestjs/common';

import { decrypt, encrypt } from '@libs/common/utils/crypto';
import { isChatGptProviderAvailable } from '@libs/core/infrastructure/services/providers/kodus-provider-availability';
import { createLogger } from '@libs/core/log/logger';
import { DistributedLockService } from '@libs/core/workflow/infrastructure/distributed-lock.service';
import {
    attachClassification,
    LlmErrorCategory,
} from '@libs/llm/error-classifier';
import { siwcError } from '@libs/llm/providers/chatgpt/api-error';
import {
    CHATGPT_PROVIDER_ID,
    CHATGPT_TOKEN_URL,
} from '@libs/llm/providers/chatgpt/constants';
import { ChatGptIdTokenVerifier } from '@libs/llm/providers/chatgpt/id-token';
import { listChatGptModels } from '@libs/llm/providers/chatgpt/models';
import { ChatGptOAuthClient } from '@libs/llm/providers/chatgpt/oauth-client';
import {
    ChatGptSessionEngine,
    type ChatGptCredentialBundle,
    type ChatGptSessionStore,
    type ImportResult,
    type RevocationResult,
} from '@libs/llm/providers/chatgpt/session-engine';
import {
    planEnabled,
    refreshDue,
    type ChatGptSessionState,
} from '@libs/llm/providers/chatgpt/session-state';
import {
    setChatGptTokenSource,
    type ChatGptTokenSource,
} from '@libs/llm/providers/chatgpt/token-source';
import type { CatalogModel } from '@libs/llm/providers/kernel/types';
import {
    CHATGPT_SESSION_REPOSITORY_TOKEN,
    IChatGptSessionRepository,
} from '@libs/organization/domain/chatgpt-session/contracts/chatgpt-session.repository.contract';
import { ChatGptSessionRecord } from '@libs/organization/domain/chatgpt-session/interfaces/chatgpt-session-record.interface';

/** The HTTP client every OpenAI call of this service uses. */
export const CHATGPT_FETCH_TOKEN = Symbol.for('ChatGptFetch');

/** Lock lease: above the longest locked path (refresh 30 s + discovery and
 *  JWKS 30 s each). */
const LOCK_TTL_MS = 120_000;
const LOCK_DEADLINE_MS = 60_000;
const LOCK_POLL_START_MS = 25;
const LOCK_POLL_MAX_MS = 250;

export interface ChatGptRegistrationSummary {
    credentialId: string;
    clientId: string;
    email?: string;
    signedIn: boolean;
    planEnabled: boolean;
    expiresAt?: string;
    pendingVerification: boolean;
    identityError?: string;
    revision: number;
}

const sleep = (ms: number) =>
    new Promise<void>((resolve) => setTimeout(resolve, ms));

function toState(r: ChatGptSessionRecord): ChatGptSessionState {
    const pending = r.pendingRefresh
        ? (JSON.parse(decrypt(r.pendingRefresh)) as {
              response: ChatGptSessionState['pendingRefresh']['response'];
              receivedAt: string;
          })
        : undefined;
    return {
        ...r,
        accessToken: r.accessToken ? decrypt(r.accessToken) : undefined,
        refreshToken: r.refreshToken ? decrypt(r.refreshToken) : undefined,
        idToken: r.idToken ? decrypt(r.idToken) : undefined,
        pendingRefresh: pending && {
            response: pending.response,
            receivedAt: new Date(pending.receivedAt),
        },
    };
}

function toRecord(s: ChatGptSessionState): ChatGptSessionRecord {
    const secret = (v?: string) => (v ? encrypt(v) : undefined);
    return {
        ...s,
        accessToken: secret(s.accessToken),
        refreshToken: secret(s.refreshToken),
        idToken: secret(s.idToken),
        pendingRefresh: s.pendingRefresh
            ? encrypt(
                  JSON.stringify({
                      response: s.pendingRefresh.response,
                      receivedAt: s.pendingRefresh.receivedAt.toISOString(),
                  }),
              )
            : undefined,
    };
}

/**
 * The ChatGPT session store of a Kodus deployment: rows in `chatgpt_sessions`
 * (tokens encrypted at rest), serialized per credential with a Postgres
 * advisory lock held across processes, and written with a revision
 * compare-and-swap. It is also the `ChatGptTokenSource` the provider module
 * asks for an access token on every request, in api and worker alike.
 *
 * Self-hosted only: on Kodus Cloud no token is ever issued, so a stored row
 * cannot be used however it got there.
 */
@Injectable()
export class ChatGptSessionService implements ChatGptTokenSource, OnModuleInit {
    private readonly logger = createLogger(ChatGptSessionService.name);
    private readonly engine: ChatGptSessionEngine;
    /** Concurrent shards of one worker share one refresh. */
    private readonly inflight = new Map<string, Promise<string>>();
    private readonly store: ChatGptSessionStore;

    constructor(
        @Inject(CHATGPT_SESSION_REPOSITORY_TOKEN)
        private readonly repository: IChatGptSessionRepository,
        private readonly locks: DistributedLockService,
        @Inject(CHATGPT_FETCH_TOKEN)
        private readonly fetchFn: typeof fetch,
    ) {
        this.store = {
            withLock: (key, fn) => this.withLock(key, fn),
            load: async (credentialId) => {
                const row =
                    await this.repository.findByCredentialId(credentialId);
                return row && toState(row);
            },
            loadByOrganization: async (organizationId) => {
                const rows =
                    await this.repository.findByOrganizationId(organizationId);
                if (rows.length > 1) {
                    throw new Error(
                        `organization ${organizationId} has ${rows.length} ChatGPT sessions; one is allowed`,
                    );
                }
                return rows[0] && toState(rows[0]);
            },
            insert: async (state) =>
                toState(await this.repository.insert(toRecord(state))),
            save: async (next, expectedRevision) => {
                const {
                    uuid,
                    organizationId: _org,
                    credentialId: _cred,
                    revision: _rev,
                    ...patch
                } = toRecord(next);
                const swapped = await this.repository.compareAndSwap(
                    uuid,
                    expectedRevision,
                    patch,
                );
                if (!swapped) {
                    // Inside the lock nobody else may write: the lease expired
                    // or the invariant broke. No token from this pass is used.
                    throw new Error(
                        `ChatGPT session ${next.credentialId} changed while locked (expected revision ${expectedRevision})`,
                    );
                }
                return { ...next, revision: expectedRevision + 1 };
            },
            delete: (uuid) => this.repository.delete(uuid),
        };
        const oauth = new ChatGptOAuthClient({ fetch: this.fetchFn });
        this.engine = new ChatGptSessionEngine({
            store: this.store,
            oauth,
            verifier: new ChatGptIdTokenVerifier(oauth),
        });
    }

    onModuleInit(): void {
        setChatGptTokenSource(this);
    }

    /** Refuse every token on Kodus Cloud. */
    private assertAvailable(): void {
        if (isChatGptProviderAvailable()) return;
        const message =
            'ChatGPT plan usage is available only on self-hosted Kodus';
        throw attachClassification(new Error(message), {
            category: LlmErrorCategory.CONFIG_INVALID,
            provider: CHATGPT_PROVIDER_ID,
            rawMessage: message,
            friendlyMessage: message,
        });
    }

    async accessToken(credentialId: string): Promise<string> {
        this.assertAvailable();
        const row = await this.repository.findByCredentialId(credentialId);
        if (
            row?.accessToken &&
            planEnabled(row.scopes) &&
            !row.pendingRefresh &&
            !row.identityError &&
            !refreshDue(row, new Date())
        ) {
            return decrypt(row.accessToken);
        }
        let shared = this.inflight.get(credentialId);
        if (!shared) {
            shared = this.engine
                .credentials(credentialId)
                .then((s) => s.accessToken)
                .finally(() => this.inflight.delete(credentialId));
            this.inflight.set(credentialId, shared);
        }
        return shared;
    }

    /** The org's ChatGPT credential id: `credentialId` when it is one of the
     *  org's sessions, else the org's only session. Undefined when none. */
    async credentialIdFor(
        organizationId: string,
        credentialId?: string,
    ): Promise<string | undefined> {
        if (credentialId) {
            return (await this.repository.existsForOrganization(
                organizationId,
                credentialId,
            ))
                ? credentialId
                : undefined;
        }
        const rows = await this.repository.findByOrganizationId(organizationId);
        return rows[0]?.credentialId;
    }

    existsForOrganization(
        organizationId: string,
        credentialId: string,
    ): Promise<boolean> {
        return this.repository.existsForOrganization(
            organizationId,
            credentialId,
        );
    }

    async registration(
        organizationId: string,
    ): Promise<ChatGptRegistrationSummary | undefined> {
        const rows = await this.repository.findByOrganizationId(organizationId);
        const r = rows[0];
        if (!r) return undefined;
        return {
            credentialId: r.credentialId,
            clientId: r.clientId,
            email: r.email,
            signedIn: !!r.accessToken,
            planEnabled: !!r.accessToken && planEnabled(r.scopes),
            expiresAt: r.accessToken ? r.expiresAt?.toISOString() : undefined,
            pendingVerification: !!r.pendingRefresh,
            identityError: r.identityError,
            revision: r.revision,
        };
    }

    async listModels(credentialId: string): Promise<CatalogModel[]> {
        const token = await this.accessToken(credentialId);
        return listChatGptModels(token, this.fetchFn);
    }

    importBundle(args: {
        organizationId: string;
        bundle: ChatGptCredentialBundle;
        hostId: string;
        replace: boolean;
    }): Promise<ImportResult> {
        this.assertAvailable();
        return this.engine.importBundle(args);
    }

    logout(credentialId: string): Promise<RevocationResult> {
        return this.engine.logout(credentialId);
    }

    /** Revoke and delete: the BYOK credential that referenced it is gone. */
    remove(credentialId: string): Promise<RevocationResult> {
        return this.engine.remove(credentialId);
    }

    /**
     * Remove every session of the org whose credential is no longer in its
     * BYOK config (deleted from the web, or by the model-delete endpoint).
     */
    async reconcile(
        organizationId: string,
        liveCredentialIds: readonly string[],
    ): Promise<void> {
        const live = new Set(liveCredentialIds);
        const rows = await this.repository.findByOrganizationId(organizationId);
        for (const row of rows) {
            if (live.has(row.credentialId)) continue;
            const result = await this.remove(row.credentialId);
            this.logger.log({
                message:
                    'Removed the ChatGPT session of a deleted BYOK credential',
                context: ChatGptSessionService.name,
                metadata: {
                    organizationId,
                    credentialId: row.credentialId,
                    revocationConfirmed: result.revocationConfirmed,
                    revocationError: result.revocationError,
                },
            });
        }
    }

    /** Hold the cross-process lock `key` around `fn`. Polls with backoff
     *  (25 ms doubling to 250 ms) and gives up after 60 s. */
    private async withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
        const deadline = Date.now() + LOCK_DEADLINE_MS;
        let wait = LOCK_POLL_START_MS;
        for (;;) {
            const lock = await this.locks.acquire(key, { ttl: LOCK_TTL_MS });
            if (lock) {
                try {
                    return await fn();
                } finally {
                    await lock.release();
                }
            }
            if (Date.now() + wait > deadline) {
                throw siwcError({
                    message: 'ChatGPT session is busy; retry the request',
                    url: CHATGPT_TOKEN_URL,
                    status: 503,
                    retryable: true,
                    category: LlmErrorCategory.TRANSIENT,
                });
            }
            await sleep(wait);
            wait = Math.min(wait * 2, LOCK_POLL_MAX_MS);
        }
    }
}
