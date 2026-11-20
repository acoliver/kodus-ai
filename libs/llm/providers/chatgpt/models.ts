/**
 * The account-specific ChatGPT model catalog: `GET /v1/models` with the
 * plan access token. Port of OpenCodeReview `internal/chatgptauth/models.go`.
 *
 * The catalog is OpenAI's, in OpenAI's order. There is no compiled allowlist:
 * an explicit slug passes through unchanged everywhere, and the server is the
 * one that refuses a slug the account cannot use.
 */
import { BodyTooLargeError, readBoundedText } from './bounded-body';
import { CHATGPT_MODELS_URL, MAX_OAUTH_BODY } from './constants';
import { siwcError, siwcHttpError, siwcTransportError } from './api-error';
import { bearerHeaders } from '../kernel/listing-helpers';
import { openaiReasoningConfig } from '../openai/reasoning';
import type { CatalogModel, ModelListing } from '../kernel/types';

const MODELS_TIMEOUT_MS = 15_000;

/** Keep `visibility: "list"` entries in server order. A listed entry without
 *  `slug` or `display_name` is a malformed catalog, not something to skip. */
export function parseChatGptModels(body: unknown): CatalogModel[] {
    const models = (body as { models?: unknown } | null)?.models;
    if (!Array.isArray(models)) {
        throw new Error('ChatGPT model catalog did not contain models');
    }
    const listed: CatalogModel[] = [];
    for (const m of models as Array<Record<string, unknown> | null>) {
        if (m?.visibility !== 'list') continue;
        if (
            typeof m.slug !== 'string' ||
            !m.slug ||
            typeof m.display_name !== 'string' ||
            !m.display_name
        ) {
            throw new Error('invalid ChatGPT model catalog entry');
        }
        const reasoningConfig = openaiReasoningConfig(m.slug);
        listed.push({
            id: m.slug,
            name: m.display_name,
            ...(reasoningConfig && {
                supportsReasoning: true as const,
                reasoningConfig,
            }),
        });
    }
    return listed;
}

/** Descriptor form, for the registry contract. Kodus lists ChatGPT models
 *  through the session service (`listChatGptModels`), never through the
 *  generic env-key fetcher: the token is not a stored API key. */
export const chatGptModelListing: ModelListing = {
    kind: 'http',
    timeoutMs: MODELS_TIMEOUT_MS,
    url: () => CHATGPT_MODELS_URL,
    headers: ({ apiKey }) => bearerHeaders(apiKey),
    parse: parseChatGptModels,
};

/** Fetch and parse the catalog. Redirects refused, 1 MiB cap, failures as
 *  classified `APICallError`s with the token redacted. */
export async function listChatGptModels(
    accessToken: string,
    fetchFn: typeof fetch,
): Promise<CatalogModel[]> {
    let response: Response;
    let body: string | undefined;
    try {
        response = await fetchFn(CHATGPT_MODELS_URL, {
            method: 'GET',
            headers: { Authorization: `Bearer ${accessToken}` },
            redirect: 'manual',
            signal: AbortSignal.timeout(MODELS_TIMEOUT_MS),
        });
        body = await readBoundedText(response, MAX_OAUTH_BODY);
    } catch (err) {
        if (!(err instanceof BodyTooLargeError)) {
            throw siwcTransportError(CHATGPT_MODELS_URL, err);
        }
        body = undefined;
    }
    if (response.status !== 200 || body === undefined) {
        throw siwcHttpError({
            url: CHATGPT_MODELS_URL,
            status: response.status,
            headers: response.headers,
            body,
            secrets: [accessToken],
        });
    }
    let parsed: unknown;
    try {
        parsed = JSON.parse(body);
    } catch {
        throw siwcError({
            message: 'invalid ChatGPT API response JSON',
            url: CHATGPT_MODELS_URL,
            status: 502,
            retryable: false,
        });
    }
    return parseChatGptModels(parsed);
}
