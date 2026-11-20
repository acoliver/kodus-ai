/**
 * The ChatGPT session lifecycle over a storage port: access tokens with
 * refresh and rotation, recovery of a refresh whose verification failed,
 * bundle import (sign-in and re-sign-in) and logout. Port of OpenCodeReview
 * `internal/chatgptauth/oauth.go` (`Login` commit, `credentials`, `Logout`).
 *
 * Every change is written through `store.save(next, expectedRevision)`, a
 * compare-and-swap, while holding `store.withLock`, and is persisted BEFORE a
 * new token is used: a refresh token the issuer has rotated exists nowhere
 * else, so losing the write would lose the session.
 */
import { randomUUID } from 'node:crypto';
import { LlmErrorCategory } from '@libs/llm/error-classifier';
import {
    CHATGPT_ISSUER,
    CHATGPT_TOKEN_URL,
    CLOCK_SKEW_MS,
    DYNAMIC_CLIENT,
    MAX_BUNDLE_AGE_MS,
} from './constants';
import { siwcError } from './api-error';
import { InvalidIdTokenError, type ChatGptIdTokenVerifier } from './id-token';
import {
    isRetryableOAuthError,
    isTerminalRefreshError,
    OAuthError,
    type ChatGptOAuthClient,
} from './oauth-client';
import {
    applyTokenResponse,
    clearedTokens,
    planEnabled,
    refreshDue,
    type ChatGptSessionState,
    type TokenResponse,
} from './session-state';

/** Storage for session rows. The engine never sees ciphertext. */
export interface ChatGptSessionStore {
    /** Run `fn` holding the exclusive lock `key` (across processes). */
    withLock<T>(key: string, fn: () => Promise<T>): Promise<T>;
    load(credentialId: string): Promise<ChatGptSessionState | undefined>;
    loadByOrganization(
        organizationId: string,
    ): Promise<ChatGptSessionState | undefined>;
    /** Insert a new row (revision 1). */
    insert(state: ChatGptSessionState): Promise<ChatGptSessionState>;
    /** Compare-and-swap on `expectedRevision`; returns the row as stored,
     *  with the incremented revision. Throws when the revision moved. */
    save(
        next: ChatGptSessionState,
        expectedRevision: number,
    ): Promise<ChatGptSessionState>;
    delete(uuid: string): Promise<void>;
}

/** What `kodus chatgpt login` uploads (or writes with `--output`). */
export interface ChatGptCredentialBundle {
    version: 1;
    issuer: string;
    clientId: string;
    extAgentHostId: string;
    nonce: string;
    receivedAt: string;
    newRegistration: boolean;
    expectedRevision: number | null;
    tokenResponse: TokenResponse;
}

/** An import the server refuses: `invalid` (400) or `conflict` (409). */
export class ChatGptSessionError extends Error {
    constructor(
        readonly kind: 'invalid' | 'conflict',
        message: string,
    ) {
        super(message);
        this.name = 'ChatGptSessionError';
    }
}

export interface RevocationResult {
    revocationConfirmed: boolean;
    /** Why revocation was not confirmed; never carries a token. */
    revocationError?: string;
}

export interface ImportResult {
    state: ChatGptSessionState;
    created: boolean;
    firstPlanUse: boolean;
    /** Set when `replace` signed out a previous account. */
    replaced?: RevocationResult;
}

export const sessionLockKey = (credentialId: string) =>
    `chatgpt-session:${credentialId}`;
export const registrationLockKey = (organizationId: string) =>
    `chatgpt-registration:${organizationId}`;

const LOGIN = 'run `kodus chatgpt login`';
const ENABLE_PLAN = 'run `kodus chatgpt login --enable-plan`';

const NEEDS_REFRESH = Symbol('needs-refresh');

function authError(message: string, cause?: unknown) {
    return siwcError({
        message,
        url: CHATGPT_TOKEN_URL,
        status: 401,
        retryable: false,
        category: LlmErrorCategory.AUTH_INVALID,
        cause,
    });
}

function transientError(message: string, retryable: boolean, cause?: unknown) {
    return siwcError({
        message,
        url: CHATGPT_TOKEN_URL,
        status: retryable ? 503 : 502,
        retryable,
        category: LlmErrorCategory.TRANSIENT,
        cause,
    });
}

const messageOf = (err: unknown) =>
    err instanceof Error ? err.message : String(err);

/** Map a non-terminal refresh failure. Tokens are kept in every case. */
function refreshFailure(err: unknown) {
    if (
        isRetryableOAuthError(err) ||
        (err instanceof OAuthError && err.code === 'temporarily_unavailable')
    ) {
        return transientError(
            `ChatGPT token refresh is temporarily unavailable: ${messageOf(err)}`,
            true,
            err,
        );
    }
    if (err instanceof OAuthError) {
        const fix =
            err.code === 'invalid_client'
                ? 'fix the ChatGPT client registration'
                : LOGIN;
        return authError(
            `ChatGPT token refresh was refused: ${err.message}; tokens kept, ${fix}`,
            err,
        );
    }
    return transientError(
        `ChatGPT token refresh failed: ${messageOf(err)}`,
        false,
        err,
    );
}

export interface ChatGptSessionEngineDeps {
    store: ChatGptSessionStore;
    oauth: ChatGptOAuthClient;
    verifier: ChatGptIdTokenVerifier;
    now?: () => Date;
    newId?: () => string;
}

export class ChatGptSessionEngine {
    private readonly store: ChatGptSessionStore;
    private readonly oauth: ChatGptOAuthClient;
    private readonly verifier: ChatGptIdTokenVerifier;
    private readonly now: () => Date;
    private readonly newId: () => string;

    constructor(deps: ChatGptSessionEngineDeps) {
        this.store = deps.store;
        this.oauth = deps.oauth;
        this.verifier = deps.verifier;
        this.now = deps.now ?? (() => new Date());
        this.newId = deps.newId ?? randomUUID;
    }

    /** Usable credentials, refreshed (and persisted) first when due. */
    async credentials(credentialId: string): Promise<ChatGptSessionState> {
        let r = await this.once(credentialId);
        if (r === NEEDS_REFRESH) r = await this.once(credentialId);
        if (r === NEEDS_REFRESH) {
            throw transientError(
                'ChatGPT access token expired during verification; retry the request',
                true,
            );
        }
        return r;
    }

    private async loadOrFail(
        credentialId: string,
    ): Promise<ChatGptSessionState> {
        const s = await this.store.load(credentialId);
        if (!s) {
            throw authError(`No ChatGPT session for this credential; ${LOGIN}`);
        }
        return s;
    }

    private once(
        credentialId: string,
    ): Promise<ChatGptSessionState | typeof NEEDS_REFRESH> {
        return this.store.withLock(sessionLockKey(credentialId), async () => {
            const s = await this.loadOrFail(credentialId);
            if (s.identityError) {
                throw authError(`${s.identityError}; ${LOGIN}`);
            }
            if (!s.accessToken) {
                throw authError(`ChatGPT account is signed out; ${LOGIN}`);
            }
            if (!planEnabled(s.scopes)) {
                throw authError(
                    `ChatGPT plan usage is disabled; ${ENABLE_PLAN}`,
                );
            }
            const recovering = !!s.pendingRefresh;
            if (!recovering && !refreshDue(s, this.now())) return s;
            if (!s.refreshToken) {
                throw authError(`ChatGPT refresh token is missing; ${LOGIN}`);
            }

            let t: TokenResponse;
            let at: Date;
            if (recovering) {
                t = s.pendingRefresh.response;
                at = s.pendingRefresh.receivedAt;
            } else {
                try {
                    t = await this.oauth.refresh({
                        clientId: s.clientId,
                        refreshToken: s.refreshToken,
                    });
                } catch (err) {
                    if (isTerminalRefreshError(err)) {
                        await this.store.save(clearedTokens(s), s.revision);
                        throw authError(
                            `ChatGPT refresh token is no longer usable (${(err as OAuthError).code}); tokens cleared, ${LOGIN}`,
                            err,
                        );
                    }
                    throw refreshFailure(err);
                }
                at = this.now();
            }

            let rotated: ReturnType<typeof applyTokenResponse>;
            try {
                rotated = applyTokenResponse(s, t, {
                    refresh: true,
                    receivedAt: at,
                });
            } catch (err) {
                throw transientError(
                    `ChatGPT refresh returned an invalid token response: ${messageOf(err)}`,
                    false,
                    err,
                );
            }

            let current = s;
            let email = s.email;
            if (typeof t.id_token === 'string' && t.id_token) {
                if (!recovering) {
                    current = await this.store.save(
                        {
                            ...s,
                            pendingRefresh: { response: t, receivedAt: at },
                        },
                        s.revision,
                    );
                }
                try {
                    const id = await this.verifier.verify(t.id_token, {
                        clientId: s.clientId,
                        at,
                    });
                    if (id.sub !== s.subject || id.iss !== s.issuer) {
                        throw new InvalidIdTokenError(
                            'refresh changed ChatGPT identity',
                        );
                    }
                    if (id.nonce && id.nonce !== s.nonce) {
                        throw new InvalidIdTokenError(
                            'refresh changed the original ID-token nonce',
                        );
                    }
                    email = id.email;
                } catch (err) {
                    if (err instanceof InvalidIdTokenError) {
                        // Keep the newest refresh token (logout revokes it),
                        // but stop retrying a rejected identity.
                        await this.store.save(
                            { ...current, identityError: err.message },
                            current.revision,
                        );
                        throw authError(`${err.message}; ${LOGIN}`, err);
                    }
                    // The pending refresh stays: the next call resumes it
                    // without spending the consumed refresh token again.
                    throw transientError(
                        `ChatGPT ID-token verification is unavailable: ${messageOf(err)}`,
                        true,
                        err,
                    );
                }
            }

            const saved = await this.store.save(
                { ...current, ...rotated, email, pendingRefresh: undefined },
                current.revision,
            );
            if (!planEnabled(saved.scopes)) {
                throw authError(
                    `refreshed ChatGPT grant does not permit plan usage; ${ENABLE_PLAN}`,
                );
            }
            const after = this.now();
            if (
                saved.expiresAt.getTime() <= after.getTime() ||
                (recovering && refreshDue(saved, after))
            ) {
                return NEEDS_REFRESH;
            }
            return saved;
        });
    }

    /**
     * Validate a credential bundle and store its session: insert a new
     * registration, update a retained one, or (with `replace`) overwrite the
     * org's registration with another account. Validation runs before any
     * write, so a refused bundle leaves the stored session as it was.
     */
    async importBundle(args: {
        organizationId: string;
        bundle: ChatGptCredentialBundle;
        hostId: string;
        replace: boolean;
    }): Promise<ImportResult> {
        const { bundle } = args;
        const receivedAt = this.checkBundle(bundle, args.hostId);
        let tokens: ReturnType<typeof applyTokenResponse>;
        try {
            tokens = applyTokenResponse({ scopes: [] }, bundle.tokenResponse, {
                refresh: false,
                receivedAt,
            });
        } catch (err) {
            throw new ChatGptSessionError('invalid', messageOf(err));
        }
        let id: Awaited<ReturnType<ChatGptIdTokenVerifier['verify']>>;
        try {
            id = await this.verifier.verify(tokens.idToken, {
                clientId: bundle.clientId,
                nonce: bundle.nonce,
                at: receivedAt,
            });
        } catch (err) {
            if (err instanceof InvalidIdTokenError) {
                throw new ChatGptSessionError('invalid', err.message);
            }
            throw err;
        }
        const signedIn = {
            ...tokens,
            clientId: bundle.clientId,
            issuer: id.iss,
            subject: id.sub,
            email: id.email,
            nonce: bundle.nonce,
            extAgentHostId: bundle.extAgentHostId,
            pendingRefresh: undefined,
            identityError: undefined,
        };

        return this.store.withLock(
            registrationLockKey(args.organizationId),
            async () => {
                const existing = await this.store.loadByOrganization(
                    args.organizationId,
                );
                if (!existing) {
                    if (!bundle.newRegistration) {
                        throw new ChatGptSessionError(
                            'conflict',
                            'No retained ChatGPT registration for this organization; sign in as a new registration',
                        );
                    }
                    const firstPlanUse = planEnabled(signedIn.scopes);
                    const state = await this.store.insert({
                        ...signedIn,
                        uuid: this.newId(),
                        organizationId: args.organizationId,
                        credentialId: this.newId(),
                        revision: 1,
                        welcomed: firstPlanUse,
                    });
                    return { state, created: true, firstPlanUse };
                }
                return this.store.withLock(
                    sessionLockKey(existing.credentialId),
                    () =>
                        this.updateRegistration(
                            existing.credentialId,
                            bundle,
                            signedIn,
                            args.replace,
                        ),
                );
            },
        );
    }

    private async updateRegistration(
        credentialId: string,
        bundle: ChatGptCredentialBundle,
        signedIn: Omit<
            ChatGptSessionState,
            'uuid' | 'organizationId' | 'credentialId' | 'revision' | 'welcomed'
        >,
        replace: boolean,
    ): Promise<ImportResult> {
        // Re-read under the session lock: a refresh may have committed since.
        const current = await this.loadOrFail(credentialId);
        if (bundle.newRegistration) {
            if (current.clientId === bundle.clientId) {
                throw new ChatGptSessionError(
                    'conflict',
                    'Issued registration already exists; sign in using that account',
                );
            }
            if (!replace) {
                throw new ChatGptSessionError(
                    'conflict',
                    'This organization already has a ChatGPT registration; sign in again without --new-account, or pass --replace',
                );
            }
            const { result: replaced, cleared } =
                await this.revokeCurrent(current);
            const firstPlanUse = planEnabled(signedIn.scopes);
            const state = await this.store.save(
                { ...cleared, ...signedIn, welcomed: firstPlanUse },
                cleared.revision,
            );
            return { state, created: false, firstPlanUse, replaced };
        }
        if (current.clientId !== bundle.clientId) {
            throw new ChatGptSessionError(
                'conflict',
                'OAuth callback changed the selected client ID',
            );
        }
        if (current.revision !== bundle.expectedRevision) {
            throw new ChatGptSessionError(
                'conflict',
                'ChatGPT registration changed during sign-in; start sign-in again',
            );
        }
        if (
            current.subject !== signedIn.subject ||
            current.issuer !== signedIn.issuer
        ) {
            throw new ChatGptSessionError(
                'conflict',
                'ChatGPT sign-in identity did not match the selected registration',
            );
        }
        const firstPlanUse = planEnabled(signedIn.scopes) && !current.welcomed;
        const state = await this.store.save(
            {
                ...current,
                ...signedIn,
                welcomed: current.welcomed || firstPlanUse,
            },
            current.revision,
        );
        return { state, created: false, firstPlanUse };
    }

    private checkBundle(bundle: ChatGptCredentialBundle, hostId: string): Date {
        const invalid = (m: string) => new ChatGptSessionError('invalid', m);
        if (!bundle || typeof bundle !== 'object' || bundle.version !== 1) {
            throw invalid('Unsupported ChatGPT credential bundle version');
        }
        if (bundle.issuer !== CHATGPT_ISSUER) {
            throw invalid('ChatGPT credential bundle has the wrong issuer');
        }
        if (
            typeof bundle.clientId !== 'string' ||
            !bundle.clientId ||
            bundle.clientId === DYNAMIC_CLIENT
        ) {
            throw invalid('OAuth registration did not issue a client ID');
        }
        if (typeof bundle.nonce !== 'string' || !bundle.nonce) {
            throw invalid('ChatGPT credential bundle has no sign-in nonce');
        }
        if (typeof bundle.newRegistration !== 'boolean') {
            throw invalid(
                'ChatGPT credential bundle must say whether it is a new registration',
            );
        }
        if (
            !bundle.newRegistration &&
            !Number.isInteger(bundle.expectedRevision)
        ) {
            throw invalid(
                'A re-sign-in bundle must carry the expected revision',
            );
        }
        if (!bundle.tokenResponse || typeof bundle.tokenResponse !== 'object') {
            throw invalid('ChatGPT credential bundle has no token response');
        }
        const received = Date.parse(bundle.receivedAt);
        const now = this.now().getTime();
        if (
            Number.isNaN(received) ||
            received < now - MAX_BUNDLE_AGE_MS ||
            received > now + CLOCK_SKEW_MS
        ) {
            throw invalid(
                'ChatGPT credential bundle receipt time is out of range',
            );
        }
        if (bundle.extAgentHostId !== hostId) {
            throw new ChatGptSessionError(
                'conflict',
                'ChatGPT credential bundle was signed in for another Kodus host; run `kodus chatgpt login` against this deployment',
            );
        }
        return new Date(received);
    }

    /** Revoke the session's refresh token (the pending one when a refresh is
     *  unverified) and clear every token; the registration stays. */
    async logout(credentialId: string): Promise<RevocationResult> {
        return this.store.withLock(sessionLockKey(credentialId), async () => {
            const s = await this.loadOrFail(credentialId);
            return (await this.revokeCurrent(s)).result;
        });
    }

    /** Logout, then delete the row: the BYOK credential that referenced it is
     *  gone, so nothing will use the registration again. */
    async remove(credentialId: string): Promise<RevocationResult> {
        return this.store.withLock(sessionLockKey(credentialId), async () => {
            const s = await this.loadOrFail(credentialId);
            const { result } = await this.revokeCurrent(s);
            await this.store.delete(s.uuid);
            return result;
        });
    }

    private async revokeCurrent(
        s: ChatGptSessionState,
    ): Promise<{ result: RevocationResult; cleared: ChatGptSessionState }> {
        let revocationError: string | undefined;
        if (s.refreshToken) {
            const token = s.pendingRefresh
                ? (s.pendingRefresh.response.refresh_token as string)
                : s.refreshToken;
            try {
                await this.oauth.revoke({
                    clientId: s.clientId,
                    refreshToken: token,
                });
            } catch (err) {
                // Reported, not swallowed: the caller tells the user to
                // disconnect the app in ChatGPT settings.
                revocationError = messageOf(err);
            }
        }
        const cleared = await this.store.save(clearedTokens(s), s.revision);
        return {
            cleared,
            result: revocationError
                ? { revocationConfirmed: false, revocationError }
                : { revocationConfirmed: true },
        };
    }
}
