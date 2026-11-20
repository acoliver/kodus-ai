/**
 * ChatGPT plan LIVE test: the real issuer and the real Responses endpoint.
 * Opt-in only. CI never sets the variable and it is not part of
 * contract-tests.yml: every run spends the plan of whoever signed in.
 *
 *   1. kodus chatgpt login --output ~/siwc.json     (against the deployment
 *      whose host id you want; any member can write the bundle)
 *   2. KODUS_SIWC_LIVE_BUNDLE=~/siwc.json \
 *        pnpm exec jest --config jest.config.ts \
 *        libs/llm/providers/chatgpt/chatgpt.live.spec.ts --no-coverage
 *
 * The first run imports the bundle into an in-memory store through the engine
 * (real JWKS verification). The catalog is listed and one structured call and
 * one two-step tool loop run against https://api.openai.com/v1/responses.
 * Every session write (import, refresh, rotation) is saved next to the bundle
 * as `<bundle>.session.json` (mode 0600) before the new tokens are used, and
 * later runs resume from it: a refresh consumes the refresh token the bundle
 * holds. Delete both files and repeat step 1 to start over.
 *
 * KODUS_SIWC_LIVE_MODEL picks a slug; default: the first one listed.
 */
import { promises as fs } from 'node:fs';
import { generateText, Output, stepCountIs, tool } from 'ai';
import { z } from 'zod';
import { chatgptModule } from './index';
import { ChatGptIdTokenVerifier } from './id-token';
import { listChatGptModels } from './models';
import { ChatGptOAuthClient } from './oauth-client';
import {
    ChatGptSessionEngine,
    type ChatGptCredentialBundle,
} from './session-engine';
import type { ChatGptSessionState } from './session-state';
import { setChatGptTokenSource } from './token-source';
import { MemoryStore } from './__fixtures__/fake-openai';

const BUNDLE = process.env.KODUS_SIWC_LIVE_BUNDLE;
const live = BUNDLE ? describe : describe.skip;

live('ChatGPT plan (live)', () => {
    jest.setTimeout(180_000);

    const sessionFile = `${BUNDLE}.session.json`;
    /** Persists every write before the engine uses the new tokens. */
    class FileStore extends MemoryStore {
        private async persist(state: ChatGptSessionState) {
            await fs.writeFile(
                sessionFile,
                `${JSON.stringify(state, null, 2)}\n`,
                { mode: 0o600 },
            );
            return state;
        }
        async insert(state: ChatGptSessionState) {
            return this.persist(await super.insert(state));
        }
        async save(next: ChatGptSessionState, expectedRevision: number) {
            return this.persist(await super.save(next, expectedRevision));
        }
    }
    const store = new FileStore();
    const oauth = new ChatGptOAuthClient({ fetch });
    const engine = new ChatGptSessionEngine({
        store,
        oauth,
        verifier: new ChatGptIdTokenVerifier(oauth),
    });
    let credentialId: string;
    let model: string;

    beforeAll(async () => {
        const saved = await fs.readFile(sessionFile, 'utf8').catch(() => null);
        if (saved) {
            const state = JSON.parse(saved, (key, value) =>
                /At$/.test(key) && typeof value === 'string'
                    ? new Date(value)
                    : value,
            ) as ChatGptSessionState;
            store.put(state);
            credentialId = state.credentialId;
        } else {
            const bundle: ChatGptCredentialBundle = JSON.parse(
                await fs.readFile(BUNDLE!, 'utf8'),
            );
            const imported = await engine.importBundle({
                organizationId: 'live-org',
                bundle: {
                    ...bundle,
                    newRegistration: true,
                    expectedRevision: null,
                },
                hostId: bundle.extAgentHostId,
                replace: false,
            });
            credentialId = imported.state.credentialId;
        }
        setChatGptTokenSource({
            accessToken: async (id) =>
                (await engine.credentials(id)).accessToken,
        });
    });

    it('lists the account catalog', async () => {
        const s = await engine.credentials(credentialId);
        const models = await listChatGptModels(s.accessToken, fetch);
        expect(models.length).toBeGreaterThan(0);
        model = process.env.KODUS_SIWC_LIVE_MODEL || models[0].id;
    });

    it('answers a structured call', async () => {
        const result = await generateText({
            model: chatgptModule.build({
                provider: 'chatgpt' as any,
                apiKey: '',
                model,
                credentialId,
            }),
            system: 'Answer with JSON only.',
            prompt: 'Is 7 a prime number?',
            output: Output.object({ schema: z.object({ prime: z.boolean() }) }),
        });
        expect(result.output).toEqual({ prime: true });
        expect(result.usage.inputTokens).toBeGreaterThan(0);
    });

    it('runs a two-step tool loop with encrypted reasoning replay', async () => {
        const read = jest.fn(async () => 'export const answer = 42;');
        const result = await generateText({
            model: chatgptModule.build({
                provider: 'chatgpt' as any,
                apiKey: '',
                model,
                credentialId,
            }),
            system: 'You review code. Use read_file before answering.',
            prompt: 'What value does a.ts export as `answer`? Reply with the number only.',
            tools: {
                read_file: tool({
                    description: 'Read a file of the repository',
                    inputSchema: z.object({ path: z.string() }),
                    execute: read,
                }),
            },
            stopWhen: stepCountIs(3),
            providerOptions: chatgptModule.reasoning(
                { provider: 'chatgpt' as any, apiKey: '', model },
                'low',
            ) as any,
        });
        expect(read).toHaveBeenCalled();
        expect(result.text).toContain('42');
    });
});
