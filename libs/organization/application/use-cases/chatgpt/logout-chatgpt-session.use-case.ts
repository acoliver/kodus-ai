import { Injectable, NotFoundException } from '@nestjs/common';

import { ChatGptSessionService } from '@libs/organization/infrastructure/adapters/services/chatgpt-session.service';

export interface LogoutChatGptSessionResult {
    revocationConfirmed: boolean;
    revocationError?: string;
}

/**
 * Revoke the org's ChatGPT session and clear its tokens; the registration (its
 * issued client id and identity) is kept so a later sign-in reuses it. Port of
 * OCR `Logout` / `runChatGPTLogout`.
 */
@Injectable()
export class LogoutChatGptSessionUseCase {
    constructor(private readonly sessions: ChatGptSessionService) {}

    async execute(organizationId: string): Promise<LogoutChatGptSessionResult> {
        const credentialId =
            await this.sessions.credentialIdFor(organizationId);
        if (!credentialId) {
            throw new NotFoundException(
                'No ChatGPT registration for this organization',
            );
        }
        return this.sessions.logout(credentialId);
    }
}
