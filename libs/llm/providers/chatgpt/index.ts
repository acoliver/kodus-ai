/**
 * ChatGPT plan provider ("Sign in with ChatGPT", self-hosted only).
 *
 * The org signs in with `kodus chatgpt login`; the rotating tokens live in the
 * `chatgpt_sessions` table, never in the BYOK blob, and reach this module per
 * request through the `ChatGptTokenSource` the organization layer wires in. The
 * BYOK credential carries no secret: only the credential id the session is
 * keyed by.
 *
 * Inference goes only to `POST https://api.openai.com/v1/responses` with
 * `store: false` and `stream: true` (see transport.ts). Port of OpenCodeReview
 * `internal/llm/chatgpt.go`.
 */
import type { LanguageModel } from 'ai';
import { createOpenAI } from '@ai-sdk/openai';
import { z } from 'zod';
import { registerProvider } from '../kernel/registry';
import { normalizeSdkResult, normalizeSdkUsage } from '../kernel/usage';
import { reasoningEffortFromWire } from '../kernel/override-wire-spelling';
import { isOpenAiReasoner, openaiReasoningConfig } from '../openai/reasoning';
import { notStoredByOpenAi } from '../openai/not-stored';
import type {
    ModelCapabilities,
    ProviderBuildConfig,
    ProviderBuildOptions,
    ProviderModule,
    ProviderReasoningOptions,
    ReasoningEffort,
} from '../kernel/types';
import type { TemperaturePolicy } from '../kernel/model-types';
import type {
    ModelReasoningTraits,
    StructuredOutputMode,
} from '../kernel/reasoning-traits';
import { CHATGPT_PROVIDER_ID, CHATGPT_RESOURCE } from './constants';
import { chatGptModelListing } from './models';
import { chatGptPlanModel } from './plan-model';
import { chatGptTokenSource } from './token-source';
import { siwcFetch } from './transport';

/** The SDK needs an API key to construct; the transport replaces the header
 *  with the session's access token on every request. */
const SIWC_TOKEN_PLACEHOLDER = 'chatgpt-session-token';

export const chatgptModule: ProviderModule = {
    id: CHATGPT_PROVIDER_ID,
    label: 'ChatGPT plan',
    doc: 'https://developers.openai.com/siwc/token-sharing-open-source',

    settingsSchema: z.object({
        accountEmail: z.string().optional(),
    }),

    capabilities(model: string): ModelCapabilities {
        const reasoningConfig = openaiReasoningConfig(model);
        return {
            supportsReasoning: !!reasoningConfig,
            reasoningConfig,
            structuredOutput: 'json_schema',
            toolCalling: 'native',
            usageGranularity: 'reasoning_split',
            streaming: true,
            // Implicit caching only; no hint is emitted.
            promptCaching: true,
        };
    },

    structuredOutputPolicy(): StructuredOutputMode {
        return 'json_schema';
    },

    build(
        cfg: ProviderBuildConfig,
        opts?: ProviderBuildOptions,
    ): LanguageModel {
        if (!cfg.credentialId) {
            throw new Error('chatgpt slot has no credentialId');
        }
        const sdk = createOpenAI({
            apiKey: SIWC_TOKEN_PLACEHOLDER,
            // Explicit: createOpenAI reads OPENAI_BASE_URL otherwise.
            baseURL: CHATGPT_RESOURCE,
            fetch: siwcFetch({
                credentialId: cfg.credentialId,
                tokenSource: chatGptTokenSource,
                inner: opts?.fetch ?? fetch,
            }),
        });
        return chatGptPlanModel(notStoredByOpenAi(sdk.responses(cfg.model)));
    },

    // `forceReasoning`: the SDK only sends `reasoning` for slugs it recognizes
    // as reasoners, and catalog slugs need not match its list. An effort the
    // model refuses fails as `subscription_sharing_unsupported_capability`.
    // `reasoningSummary: null` suppresses the SDK's default `detailed`
    // summary, so the wire matches what OpenCodeReview sends.
    reasoning(
        _cfg: ProviderBuildConfig,
        effort: ReasoningEffort,
    ): ProviderReasoningOptions {
        if (effort === 'none') return {};
        return {
            openai: {
                reasoningEffort: effort,
                forceReasoning: true,
                reasoningSummary: null,
            },
        };
    },

    reasoningTraits(cfg: ProviderBuildConfig): ModelReasoningTraits {
        return {
            thinksByDefault: isOpenAiReasoner(cfg.model),
            canDisableThinking: true,
            supportsForcedToolChoice: true,
            forcedToolChoiceRejectsThinking: false,
        };
    },

    // The preview rejects `temperature` on every model.
    temperaturePolicy(): TemperaturePolicy {
        return { kind: 'unsupported' };
    },

    normalizeUsage: normalizeSdkUsage,
    normalize: normalizeSdkResult,

    // Nothing to type: the credential is connected with `kodus chatgpt login`.
    uiFields: [],
    providerOptionsNamespace: () => 'openai',
    normalizeReasoningOverride: (_ns, options) =>
        reasoningEffortFromWire(options),
    reasoningOverrideExample: () => '{\n  "reasoningEffort": "high"\n}',
    modelListing: (id) =>
        id === CHATGPT_PROVIDER_ID ? chatGptModelListing : null,
    // Cannot be declared through API_LLM_PROVIDER: it needs a signed-in session.
    selfHostedEnv: () => null,
};

registerProvider(chatgptModule);
