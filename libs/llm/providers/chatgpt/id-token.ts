/**
 * ChatGPT ID-token verification against OpenAI's JWKS. Port of OpenCodeReview
 * `internal/chatgptauth/jwt.go`: RS256 only, a JWKS cache of five minutes that
 * refetches on an unknown `kid`, strict key rules, and the claim rules of
 * `verifyAt` (issuer, subject, audience/azp, lifetime at a given instant,
 * nonce).
 *
 * `InvalidIdTokenError` means the token itself is not acceptable. Every other
 * failure (discovery or JWKS unreachable) is a transport problem the caller
 * may retry without discarding anything.
 */
import { createPublicKey, verify, type KeyObject } from 'node:crypto';
import { CHATGPT_ISSUER, CLOCK_SKEW_MS, MAX_ID_TOKEN } from './constants';
import type { ChatGptOAuthClient } from './oauth-client';

export class InvalidIdTokenError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'InvalidIdTokenError';
    }
}

export interface IdTokenClaims {
    iss: string;
    sub: string;
    email?: string;
    nonce?: string;
}

interface Jwk {
    kid?: unknown;
    kty?: unknown;
    alg?: unknown;
    use?: unknown;
    n?: unknown;
    e?: unknown;
}

const JWKS_TTL_MS = 5 * 60_000;
const BASE64URL = /^[A-Za-z0-9_-]*$/;

function decodeSegment(segment: string): Buffer {
    if (!BASE64URL.test(segment)) throw new Error('invalid base64url');
    return Buffer.from(segment, 'base64url');
}

function decodeJson(segment: string): Record<string, unknown> {
    const value: unknown = JSON.parse(decodeSegment(segment).toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error('not a JSON object');
    }
    return value as Record<string, unknown>;
}

function bitLength(bytes: Buffer): number {
    let i = 0;
    while (i < bytes.length && bytes[i] === 0) i++;
    if (i === bytes.length) return 0;
    return (bytes.length - i - 1) * 8 + (32 - Math.clz32(bytes[i]));
}

/** RSA, RS256, signing use, a modulus of at least 2048 bits and an odd
 *  exponent between 3 and 2^31-1. */
function rsaKey(k: Jwk): KeyObject {
    if (
        k.kty !== 'RSA' ||
        k.alg !== 'RS256' ||
        (k.use !== undefined && k.use !== '' && k.use !== 'sig') ||
        typeof k.n !== 'string' ||
        typeof k.e !== 'string'
    ) {
        throw new Error('ID-token signing key is not supported');
    }
    let n: Buffer;
    let e: Buffer;
    try {
        n = decodeSegment(k.n);
        e = decodeSegment(k.e);
    } catch {
        throw new Error('invalid RSA signing key');
    }
    if (e.length === 0 || e.length > 4) {
        throw new Error('invalid RSA exponent');
    }
    const exponent = e.reduce((acc, b) => acc * 256 + b, 0);
    if (
        bitLength(n) < 2048 ||
        exponent < 3 ||
        exponent > 2 ** 31 - 1 ||
        exponent % 2 === 0
    ) {
        throw new Error('invalid RSA signing key');
    }
    return createPublicKey({
        key: { kty: 'RSA', n: k.n, e: k.e },
        format: 'jwk',
    });
}

export class ChatGptIdTokenVerifier {
    private keys: Jwk[] = [];
    private until = 0;
    private inflight?: Promise<Jwk[]>;

    constructor(
        private readonly oauth: ChatGptOAuthClient,
        private readonly now: () => number = Date.now,
    ) {}

    /**
     * Verify `token` for `clientId`. `at` is the instant the lifetime is
     * checked at: the receipt time for an imported bundle or a persisted
     * refresh, since the token reached us over the issuer's authenticated
     * connection and must not expire just because verification was delayed.
     */
    async verify(
        token: string,
        opts: { clientId: string; nonce?: string; at?: Date },
    ): Promise<IdTokenClaims> {
        const parts = token.split('.');
        if (parts.length !== 3 || token.length > MAX_ID_TOKEN) {
            throw new InvalidIdTokenError('invalid ID token');
        }
        let header: Record<string, unknown>;
        try {
            header = decodeJson(parts[0]);
        } catch {
            throw new InvalidIdTokenError('invalid ID-token signing header');
        }
        if (
            header.alg !== 'RS256' ||
            typeof header.kid !== 'string' ||
            !header.kid ||
            (Array.isArray(header.crit) && header.crit.length > 0) ||
            (header.crit !== undefined && !Array.isArray(header.crit))
        ) {
            throw new InvalidIdTokenError('invalid ID-token signing header');
        }
        const key = await this.signingKey(header.kid);
        let signature: Buffer;
        try {
            signature = decodeSegment(parts[2]);
        } catch {
            throw new InvalidIdTokenError('invalid ID-token signature');
        }
        if (
            !verify(
                'RSA-SHA256',
                Buffer.from(`${parts[0]}.${parts[1]}`),
                key,
                signature,
            )
        ) {
            throw new InvalidIdTokenError('invalid ID-token signature');
        }
        let claims: Record<string, unknown>;
        try {
            claims = decodeJson(parts[1]);
        } catch {
            throw new InvalidIdTokenError('invalid ID-token claims');
        }
        return checkClaims(claims, opts, opts.at?.getTime() ?? this.now());
    }

    /** The JWKS key for `kid`, from cache when fresh. Concurrent lookups
     *  share one discovery + JWKS fetch.
     *
     *  A missing or unusable key is NOT an `InvalidIdTokenError`: the JWKS is
     *  the issuer's document, not the token, and a key rotation in progress
     *  must leave a pending refresh recoverable (OCR `jwks_missing_key`). */
    private async signingKey(kid: string): Promise<KeyObject> {
        let k = this.keys.find((x) => x.kid === kid);
        if (!k || this.now() > this.until) {
            this.inflight ??= this.fetchKeys().finally(() => {
                this.inflight = undefined;
            });
            this.keys = await this.inflight;
            k = this.keys.find((x) => x.kid === kid);
        }
        if (!k) throw new Error('ID-token signing key is not supported');
        return rsaKey(k);
    }

    private async fetchKeys(): Promise<Jwk[]> {
        const d = await this.oauth.discover();
        const set = (await this.oauth.getJson(d.jwks_uri)) as {
            keys?: unknown;
        } | null;
        if (!set || !Array.isArray(set.keys)) {
            throw new Error('invalid OpenAI JWKS document');
        }
        this.until = this.now() + JWKS_TTL_MS;
        return set.keys as Jwk[];
    }
}

const isNum = (v: unknown): v is number =>
    typeof v === 'number' && Number.isFinite(v);

function checkClaims(
    c: Record<string, unknown>,
    opts: { clientId: string; nonce?: string },
    atMs: number,
): IdTokenClaims {
    const invalid = () =>
        new InvalidIdTokenError(
            'ID-token issuer, audience, subject or lifetime did not match',
        );
    let audiences: unknown[];
    if (typeof c.aud === 'string') audiences = [c.aud];
    else if (Array.isArray(c.aud)) audiences = c.aud;
    else throw new InvalidIdTokenError('invalid ID-token audience');
    if (audiences.some((a) => typeof a !== 'string')) {
        throw new InvalidIdTokenError('invalid ID-token audience');
    }
    const now = Math.floor(atMs / 1000);
    const skew = CLOCK_SKEW_MS / 1000;
    const azp = c.azp;
    if (
        (azp !== undefined && typeof azp !== 'string') ||
        (c.nbf !== undefined && !isNum(c.nbf)) ||
        (c.nonce !== undefined && typeof c.nonce !== 'string') ||
        (c.email !== undefined && typeof c.email !== 'string')
    ) {
        throw new InvalidIdTokenError('invalid ID-token claims');
    }
    if (
        c.iss !== CHATGPT_ISSUER ||
        typeof c.sub !== 'string' ||
        !c.sub ||
        !audiences.includes(opts.clientId) ||
        !isNum(c.exp) ||
        c.exp <= now ||
        !isNum(c.iat) ||
        c.iat <= 0 ||
        c.iat > now + skew ||
        (isNum(c.nbf) && c.nbf > now + skew) ||
        (azp !== undefined && azp !== '' && azp !== opts.clientId) ||
        (audiences.length > 1 && azp !== opts.clientId)
    ) {
        throw invalid();
    }
    if (opts.nonce && c.nonce !== opts.nonce) {
        throw new InvalidIdTokenError('ID-token nonce did not match');
    }
    return {
        iss: c.iss,
        sub: c.sub,
        email: (c.email as string | undefined) || undefined,
        nonce: (c.nonce as string | undefined) || undefined,
    };
}
