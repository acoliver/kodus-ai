/**
 * Sign in with ChatGPT (SIWC) protocol constants. Ported from OpenCodeReview's
 * `internal/chatgptauth/oauth.go` and `internal/llm/responses_client.go`; the
 * values are fixed by OpenAI's preview, not configurable.
 */
import { OPENAI_API_BASE_URL } from '../openai/endpoint';

export const CHATGPT_PROVIDER_ID = 'chatgpt';

export const CHATGPT_ISSUER = 'https://auth.openai.com';
/** The OAuth `resource` and the only inference base URL. */
export const CHATGPT_RESOURCE = OPENAI_API_BASE_URL;
export const CHATGPT_RESPONSES_URL = `${CHATGPT_RESOURCE}/responses`;
export const CHATGPT_MODELS_URL = `${CHATGPT_RESOURCE}/models`;
export const CHATGPT_TOKEN_URL = `${CHATGPT_ISSUER}/api/accounts/oauth/token`;
export const CHATGPT_DISCOVERY_URL = `${CHATGPT_ISSUER}/.well-known/openid-configuration`;

/** Client id for a first registration; the issuer replaces it with an
 *  issued `oaiapp_...` id that every later request uses. */
export const DYNAMIC_CLIENT = 'dynamic_agent_client';
export const CHATGPT_SCOPE =
    'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct';
/** Both are required before any request may use the plan. */
export const PLAN_SCOPES = ['chatgpt.tokens.use.direct', 'resource.invoke'];

export const CHATGPT_USAGE_URL = 'https://chatgpt.com/settings/usage';

/** Every function tool is offered inside this namespace, and every function
 *  call the model returns must carry it. */
export const KODUS_TOOL_NAMESPACE = {
    name: 'kodus',
    description: 'Kodus code review tools',
} as const;

/** Refresh when the access token has less than this left (after
 *  `earliest_refresh_at`). */
export const REFRESH_WINDOW_MS = 5 * 60_000;
export const OAUTH_TIMEOUT_MS = 30_000;
export const MAX_OAUTH_BODY = 1 << 20;
export const MAX_ID_TOKEN = 1 << 20;
export const MAX_STREAM_OUTPUT = 16 << 20;
/** Per-item bookkeeping so a stream of tiny items is bounded too. */
export const STREAM_ITEM_OVERHEAD = 64;
/** A bundle older than the refresh-token lifetime cannot be imported. */
export const MAX_BUNDLE_AGE_MS = 30 * 24 * 60 * 60_000;
export const CLOCK_SKEW_MS = 5_000;
