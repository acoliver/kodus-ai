/**
 * The stored state of one ChatGPT sign-in, and the pure rules over it. Port of
 * OpenCodeReview `internal/chatgptauth/store.go` (`Auth`, `PlanEnabled`,
 * `clear`) and `oauth.go` (`tokenResponse.applyAt`, `refreshDue`).
 */
import { PLAN_SCOPES, REFRESH_WINDOW_MS } from './constants';

/** The token endpoint body, verbatim. Fields are `unknown` until
 *  `applyTokenResponse` has checked them: this is external input. */
export interface TokenResponse {
    access_token?: unknown;
    refresh_token?: unknown;
    id_token?: unknown;
    token_type?: unknown;
    expires_in?: unknown;
    scope?: unknown;
    earliest_refresh_at?: unknown;
}

/** A rotated token response received but not yet verified. The issuer may
 *  already have consumed the previous refresh token, so it is kept durable
 *  and never used for inference until its ID token verifies. */
export interface PendingRefresh {
    response: TokenResponse;
    receivedAt: Date;
}

export interface ChatGptSessionState {
    uuid: string;
    organizationId: string;
    credentialId: string;
    /** Compare-and-swap counter; every persisted change increments it. */
    revision: number;
    clientId: string;
    issuer: string;
    subject: string;
    email?: string;
    extAgentHostId: string;
    accessToken?: string;
    refreshToken?: string;
    idToken?: string;
    /** The original sign-in nonce. */
    nonce?: string;
    tokenType?: string;
    scopes: string[];
    expiresAt?: Date;
    earliestRefreshAt?: Date;
    pendingRefresh?: PendingRefresh;
    /** Set when a refreshed ID token was rejected: retries stop until the
     *  user signs in again. */
    identityError?: string;
    welcomed: boolean;
}

/** The tokens and expiry fields `applyTokenResponse` writes. */
export type SessionTokens = Pick<
    ChatGptSessionState,
    | 'accessToken'
    | 'refreshToken'
    | 'idToken'
    | 'tokenType'
    | 'scopes'
    | 'expiresAt'
    | 'earliestRefreshAt'
>;

export class InvalidTokenResponseError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'InvalidTokenResponseError';
    }
}

const MAX_EXPIRES_IN = 86_400;

/** Both plan scopes granted. */
export function planEnabled(scopes: readonly string[]): boolean {
    return PLAN_SCOPES.every((s) => scopes.includes(s));
}

/** Expired, or inside the refresh window and past `earliest_refresh_at`. */
export function refreshDue(
    s: Pick<ChatGptSessionState, 'expiresAt' | 'earliestRefreshAt'>,
    now: Date,
): boolean {
    const expires = s.expiresAt?.getTime() ?? 0;
    if (now.getTime() >= expires) return true;
    return (
        expires <= now.getTime() + REFRESH_WINDOW_MS &&
        now.getTime() >= (s.earliestRefreshAt?.getTime() ?? 0)
    );
}

/** Signed out: every token, the nonce, scopes, expiry, the pending refresh and
 *  the identity error go; the registration (client, subject, issuer, email,
 *  host) stays. */
export function clearedTokens(s: ChatGptSessionState): ChatGptSessionState {
    return {
        ...s,
        accessToken: undefined,
        refreshToken: undefined,
        idToken: undefined,
        nonce: undefined,
        tokenType: undefined,
        scopes: [],
        expiresAt: undefined,
        earliestRefreshAt: undefined,
        pendingRefresh: undefined,
        identityError: undefined,
    };
}

const RFC3339 =
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

function parseEarliest(value: unknown): Date | undefined {
    if (value === undefined || value === null) return undefined;
    if (typeof value === 'number' && Number.isInteger(value)) {
        return new Date(value * 1000);
    }
    if (typeof value === 'string' && RFC3339.test(value)) {
        const ms = Date.parse(value);
        if (!Number.isNaN(ms)) return new Date(ms);
    }
    throw new InvalidTokenResponseError('invalid earliest_refresh_at');
}

const nonEmpty = (v: unknown): v is string =>
    typeof v === 'string' && v.length > 0;

/**
 * Validate a token response and return the token fields it sets. Nothing is
 * applied on failure, so prior tokens survive a malformed rotation.
 *
 * A refresh may omit `id_token` and `scope`: the previous ID token and grant
 * are then kept. A sign-in must carry both.
 */
export function applyTokenResponse(
    current: SessionTokens,
    t: TokenResponse,
    opts: { refresh: boolean; receivedAt: Date },
): SessionTokens {
    const expiresIn = t.expires_in;
    if (
        !nonEmpty(t.access_token) ||
        !nonEmpty(t.refresh_token) ||
        typeof t.token_type !== 'string' ||
        t.token_type.toLowerCase() !== 'bearer' ||
        typeof expiresIn !== 'number' ||
        !Number.isInteger(expiresIn) ||
        expiresIn <= 0 ||
        expiresIn > MAX_EXPIRES_IN
    ) {
        throw new InvalidTokenResponseError(
            'ChatGPT token response is missing credentials, Bearer type or valid expiry',
        );
    }
    const scope = t.scope;
    if (scope !== undefined && scope !== null && typeof scope !== 'string') {
        throw new InvalidTokenResponseError('invalid granted scope');
    }
    if (t.id_token !== undefined && typeof t.id_token !== 'string') {
        throw new InvalidTokenResponseError('invalid ID token');
    }
    if (!opts.refresh && (!nonEmpty(t.id_token) || typeof scope !== 'string')) {
        throw new InvalidTokenResponseError(
            'ChatGPT sign-in response is missing ID token or granted scopes',
        );
    }
    const expiresAt = new Date(opts.receivedAt.getTime() + expiresIn * 1000);
    const earliestRefreshAt = parseEarliest(t.earliest_refresh_at);
    if (earliestRefreshAt && earliestRefreshAt > expiresAt) {
        throw new InvalidTokenResponseError(
            'earliest_refresh_at exceeds token expiry',
        );
    }
    return {
        accessToken: t.access_token,
        refreshToken: t.refresh_token,
        tokenType: 'Bearer',
        expiresAt,
        earliestRefreshAt,
        idToken: nonEmpty(t.id_token) ? t.id_token : current.idToken,
        scopes:
            typeof scope === 'string'
                ? scope.split(/\s+/).filter(Boolean)
                : current.scopes,
    };
}
