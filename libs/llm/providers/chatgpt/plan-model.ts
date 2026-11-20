/**
 * The call options a ChatGPT-plan request needs, applied above the AI SDK's
 * Responses model (same proxy technique as `providers/openai/not-stored.ts`):
 *
 *  - system prompts go out as `developer` items (the preview rejects explicit
 *    system message items);
 *  - every function tool is offered inside the Kodus namespace, and every
 *    replayed assistant tool call carries it, so replay never depends on
 *    metadata surviving from the previous step;
 *  - a named `toolChoice` is refused (namespaced tools are invisible to
 *    `allowed_tools`);
 *  - streaming is refused: Kodus calls generate only, and the transport turns
 *    that one call into the streaming request the preview requires.
 *
 * Port of OpenCodeReview `responses_client.go` `buildResponsesParams`.
 */
import type { LanguageModel } from 'ai';
import { LlmErrorCategory } from '@libs/llm/error-classifier';
import { CHATGPT_RESPONSES_URL, KODUS_TOOL_NAMESPACE } from './constants';
import { siwcError } from './api-error';

type Options = Record<string, any>;

const withOpenAi = (
    providerOptions: Record<string, any> | undefined,
    extra: Record<string, unknown>,
) => ({
    ...(providerOptions ?? {}),
    openai: { ...(providerOptions?.openai ?? {}), ...extra },
});

function planOptions(options: Options): Options {
    if (options?.toolChoice?.type === 'tool') {
        throw siwcError({
            message:
                'ChatGPT plan: a named tool_choice is not supported with namespaced tools',
            url: CHATGPT_RESPONSES_URL,
            status: 400,
            retryable: false,
            category: LlmErrorCategory.REQUEST_REJECTED,
        });
    }
    const tools = options?.tools?.map((tool: Options) =>
        tool?.type === 'function'
            ? {
                  ...tool,
                  providerOptions: withOpenAi(tool.providerOptions, {
                      namespace: KODUS_TOOL_NAMESPACE,
                  }),
              }
            : tool,
    );
    const prompt = options?.prompt?.map((message: Options) =>
        message?.role === 'assistant' && Array.isArray(message.content)
            ? {
                  ...message,
                  content: message.content.map((part: Options) =>
                      part?.type === 'tool-call'
                          ? {
                                ...part,
                                providerOptions: withOpenAi(
                                    part.providerOptions,
                                    { namespace: KODUS_TOOL_NAMESPACE.name },
                                ),
                            }
                          : part,
                  ),
              }
            : message,
    );
    const openai = options?.providerOptions?.openai ?? {};
    // An effort from a pasted override replaces the module's reasoning
    // options, so the two defaults that make the wire right are applied here
    // too: send `reasoning` for any slug (the SDK only does for slugs it
    // recognizes), and no summary unless one was asked for.
    const reasoningDefaults =
        openai.reasoningEffort != null
            ? {
                  ...(openai.forceReasoning === undefined
                      ? { forceReasoning: true }
                      : {}),
                  ...(openai.reasoningSummary === undefined
                      ? { reasoningSummary: null }
                      : {}),
              }
            : {};
    return {
        ...options,
        ...(tools ? { tools } : {}),
        ...(prompt ? { prompt } : {}),
        providerOptions: withOpenAi(options?.providerOptions, {
            ...reasoningDefaults,
            systemMessageMode: 'developer',
        }),
    };
}

export function chatGptPlanModel(model: LanguageModel): LanguageModel {
    if (typeof model !== 'object' || model === null) {
        throw new Error('chatGptPlanModel needs a LanguageModel object');
    }
    return new Proxy(model, {
        get(target: any, prop, receiver) {
            if (prop === 'doGenerate') {
                return (options: Options) =>
                    target.doGenerate(planOptions(options));
            }
            if (prop === 'doStream') {
                return () =>
                    Promise.reject(
                        new Error(
                            'ChatGPT plan provider supports generate calls only',
                        ),
                    );
            }
            return Reflect.get(target, prop, receiver);
        },
    }) as LanguageModel;
}
