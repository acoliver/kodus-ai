/**
 * A `chatgpt_sessions` row as stored. `accessToken`, `refreshToken`, `idToken`
 * and `pendingRefresh` are CIPHERTEXT; `ChatGptSessionService` is the only
 * reader that decrypts them. Absent values are `undefined`.
 */
export interface ChatGptSessionRecord {
    uuid: string;
    organizationId: string;
    credentialId: string;
    revision: number;
    clientId: string;
    issuer: string;
    subject: string;
    email?: string;
    extAgentHostId: string;
    accessToken?: string;
    refreshToken?: string;
    idToken?: string;
    nonce?: string;
    tokenType?: string;
    scopes: string[];
    expiresAt?: Date;
    earliestRefreshAt?: Date;
    pendingRefresh?: string;
    identityError?: string;
    welcomed: boolean;
}

/** The columns a compare-and-swap writes: everything but the identity of the
 *  row, its owner and its revision (the repository increments that). */
export type ChatGptSessionPatch = Omit<
    ChatGptSessionRecord,
    'uuid' | 'organizationId' | 'credentialId' | 'revision'
>;
