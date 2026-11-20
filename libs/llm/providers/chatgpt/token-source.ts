/**
 * Where the provider module gets a ChatGPT access token. libs/llm has no
 * database and no NestJS, so the organization layer wires its session service
 * in at startup (`ChatGptSessionService.onModuleInit`). Port of OpenCodeReview
 * `internal/llm/chatgpt.go` `chatGPTCredentials`.
 */
export interface ChatGptTokenSource {
    /** A usable access token for the credential, refreshed and persisted
     *  first when due. Throws a classified error when there is none. */
    accessToken(credentialId: string): Promise<string>;
}

let current: ChatGptTokenSource | undefined;

export function setChatGptTokenSource(source: ChatGptTokenSource): void {
    current = source;
}

/** The wired source. A process that builds a ChatGPT model without one has a
 *  wiring bug, not a missing credential, so this fails loudly. */
export function chatGptTokenSource(): ChatGptTokenSource {
    if (!current) {
        throw new Error('ChatGPT token source is not wired in this process');
    }
    return current;
}
