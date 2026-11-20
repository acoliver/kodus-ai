/**
 * ID-token verification. Ports OpenCodeReview `TestVerifyIDToken`,
 * `TestSigningKeyCacheAndCancellation` and `TestDiscoveryAndJWKSFailures`.
 */
import { generateKeyPairSync } from 'node:crypto';
import { ChatGptIdTokenVerifier, InvalidIdTokenError } from './id-token';
import { ChatGptOAuthClient } from './oauth-client';
import { FakeIssuer, JWKS_URL, json } from './__fixtures__/fake-openai';
import { CHATGPT_DISCOVERY_URL, CHATGPT_ISSUER } from './constants';

function setup(now: () => number = Date.now) {
    const issuer = new FakeIssuer();
    const verifier = new ChatGptIdTokenVerifier(
        new ChatGptOAuthClient({ fetch: issuer.fetch }),
        now,
    );
    return { issuer, verifier };
}

const opts = { clientId: 'oaiapp_one', nonce: 'nonce' };

describe('ChatGptIdTokenVerifier', () => {
    it('accepts a valid token and returns its identity', async () => {
        const { issuer, verifier } = setup();
        await expect(verifier.verify(issuer.jwt(), opts)).resolves.toEqual({
            iss: CHATGPT_ISSUER,
            sub: 'subject',
            email: 'test@example.invalid',
            nonce: 'nonce',
        });
    });

    const now = Math.floor(Date.now() / 1000);
    it.each<[string, unknown]>([
        ['iss', 'other'],
        ['aud', 'wrong'],
        ['exp', 1],
        ['nonce', 'wrong'],
        ['sub', ''],
        ['iat', undefined],
        ['nbf', now + 3600],
        ['aud', ['oaiapp_one', 'other']],
        ['azp', 'other'],
    ])('rejects claim %s=%j', async (field, value) => {
        const { issuer, verifier } = setup();
        const claims = { ...issuer.claims, [field]: value };
        if (value === undefined) delete claims[field];
        await expect(
            verifier.verify(issuer.jwt(claims), opts),
        ).rejects.toBeInstanceOf(InvalidIdTokenError);
    });

    it('accepts several audiences when azp names the client', async () => {
        const { issuer, verifier } = setup();
        const claims = {
            ...issuer.claims,
            aud: ['oaiapp_one', 'other'],
            azp: 'oaiapp_one',
        };
        await expect(
            verifier.verify(issuer.jwt(claims), opts),
        ).resolves.toMatchObject({
            sub: 'subject',
        });
    });

    it('rejects a bad signature, alg none and malformed tokens', async () => {
        const { issuer, verifier } = setup();
        const good = issuer.jwt();
        const parts = good.split('.');
        const badSig = [
            parts[0],
            parts[1],
            Buffer.from('bad').toString('base64url'),
        ].join('.');
        const none = good.replace(
            parts[0],
            Buffer.from('{"alg":"none","kid":"key"}').toString('base64url'),
        );
        for (const bad of [badSig, 'bad', 'e30.e30.e30', none, `${good}bad`]) {
            await expect(verifier.verify(bad, opts)).rejects.toBeInstanceOf(
                InvalidIdTokenError,
            );
        }
    });

    it('rejects a header with crit', async () => {
        const { issuer, verifier } = setup();
        const token = issuer.jwt(issuer.claims, {
            alg: 'RS256',
            kid: 'key',
            crit: ['exp'],
        });
        await expect(verifier.verify(token, opts)).rejects.toBeInstanceOf(
            InvalidIdTokenError,
        );
    });

    it('checks the lifetime at the given instant, not now', async () => {
        const { issuer, verifier } = setup();
        const received = Date.now() - 10 * 60_000;
        const claims = {
            ...issuer.claims,
            iat: Math.floor(received / 1000),
            exp: Math.floor(received / 1000) + 60,
        };
        await expect(
            verifier.verify(issuer.jwt(claims), {
                ...opts,
                at: new Date(received),
            }),
        ).resolves.toBeDefined();
        await expect(
            verifier.verify(issuer.jwt(claims), opts),
        ).rejects.toBeInstanceOf(InvalidIdTokenError);
    });

    it('shares one discovery + JWKS fetch across concurrent lookups and caches it', async () => {
        const { issuer, verifier } = setup();
        const token = issuer.jwt();
        await Promise.all(
            Array.from({ length: 8 }, () => verifier.verify(token, opts)),
        );
        expect(issuer.discoveries).toBe(1);
        expect(issuer.jwksFetches).toBe(1);
        await verifier.verify(token, opts);
        expect(issuer.jwksFetches).toBe(1);
    });

    it('refetches after five minutes and on an unknown kid', async () => {
        let clock = Date.now();
        const { issuer, verifier } = setup(() => clock);
        await verifier.verify(issuer.jwt(), opts);
        clock += 5 * 60_000 + 1;
        await verifier.verify(issuer.jwt(), opts);
        expect(issuer.jwksFetches).toBe(2);
        await expect(
            verifier.verify(
                issuer.jwt(issuer.claims, { alg: 'RS256', kid: 'rotated' }),
                opts,
            ),
        ).rejects.toThrow('signing key is not supported');
        expect(issuer.jwksFetches).toBe(3);
    });

    it.each([
        [
            'small modulus',
            () => {
                const { publicKey } = generateKeyPairSync('rsa', {
                    modulusLength: 1024,
                });
                return {
                    ...publicKey.export({ format: 'jwk' }),
                    kid: 'key',
                    alg: 'RS256',
                };
            },
        ],
        [
            'even exponent',
            (jwk: Record<string, unknown>) => ({ ...jwk, e: 'AQAC' }),
        ],
        [
            'encryption use',
            (jwk: Record<string, unknown>) => ({ ...jwk, use: 'enc' }),
        ],
        [
            'empty exponent',
            (jwk: Record<string, unknown>) => ({ ...jwk, e: '' }),
        ],
        [
            'invalid modulus',
            (jwk: Record<string, unknown>) => ({ ...jwk, n: 'invalid!' }),
        ],
    ])(
        'rejects a JWKS key with %s (not as an invalid token)',
        async (_name, make) => {
            const { issuer, verifier } = setup();
            const key = make(issuer.publicJwk);
            issuer.intercept = (url) =>
                url === JWKS_URL ? json({ keys: [key] }) : undefined;
            const err = await verifier
                .verify(issuer.jwt(), opts)
                .catch((e) => e);
            expect(err).toBeInstanceOf(Error);
            expect(err).not.toBeInstanceOf(InvalidIdTokenError);
        },
    );

    it.each([
        ['empty', {}],
        ['wrong issuer', { issuer: 'wrong' }],
        [
            'foreign JWKS host',
            {
                issuer: CHATGPT_ISSUER,
                jwks_uri: 'https://evil.invalid/jwks',
                revocation_endpoint: 'https://evil.invalid/revoke',
            },
        ],
    ])('rejects discovery with %s', async (_name, body) => {
        const { issuer, verifier } = setup();
        issuer.intercept = (url) =>
            url === CHATGPT_DISCOVERY_URL ? json(body) : undefined;
        await expect(verifier.verify(issuer.jwt(), opts)).rejects.toThrow(
            'discovery endpoints or issuer did not match',
        );
    });

    it('reports a JWKS 503 as a transport failure, not an invalid token', async () => {
        const { issuer, verifier } = setup();
        issuer.intercept = (url) =>
            url === JWKS_URL
                ? json({ error: 'temporarily_unavailable' }, 503)
                : undefined;
        const err = await verifier.verify(issuer.jwt(), opts).catch((e) => e);
        expect(err).not.toBeInstanceOf(InvalidIdTokenError);
        expect(err.message).toContain('status=503');
    });
});
