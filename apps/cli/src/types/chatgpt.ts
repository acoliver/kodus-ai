/**
 * Sign in with ChatGPT, as the CLI and the Kodus API exchange it. The bundle
 * mirrors the server's `ChatGptCredentialBundle`
 * (libs/llm/providers/chatgpt/session-engine.ts): the CLI runs the browser
 * sign-in and exchanges the code; the server validates everything else.
 */

/** The token endpoint body, verbatim. */
export interface ChatGptTokenResponse {
    access_token: string;
    refresh_token: string;
    id_token: string;
    token_type: string;
    expires_in: number;
    scope: string;
    earliest_refresh_at?: number | string | null;
}

export interface ChatGptCredentialBundle {
    version: 1;
    issuer: string;
    clientId: string;
    extAgentHostId: string;
    nonce: string;
    receivedAt: string;
    newRegistration: boolean;
    expectedRevision: number | null;
    tokenResponse: ChatGptTokenResponse;
}

export interface ChatGptRegistration {
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

export interface ChatGptRegistrationResponse {
    hostId: string;
    registration: ChatGptRegistration | null;
}

export interface ChatGptImportRequest {
    bundle: ChatGptCredentialBundle;
    model?: string;
    setDefault?: boolean;
    replace?: boolean;
}

export interface ChatGptImportResult {
    credentialId: string;
    modelId?: string;
    model?: string;
    models: Array<{ id: string; name: string }>;
    email?: string;
    planEnabled: boolean;
    firstPlanUse: boolean;
    replacedRevocationConfirmed?: boolean;
}

export interface ChatGptLogoutResult {
    revocationConfirmed: boolean;
    revocationError?: string;
}

export interface ChatGptModelTestResult {
    ok: boolean;
    code: string;
    latencyMs: number;
    message?: string;
    providerMessage?: string;
}
