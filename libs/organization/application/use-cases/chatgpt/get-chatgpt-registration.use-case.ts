import { Injectable } from '@nestjs/common';

import { ChatGptHostIdService } from '@libs/organization/infrastructure/adapters/services/chatgpt-host-id.service';
import {
    ChatGptRegistrationSummary,
    ChatGptSessionService,
} from '@libs/organization/infrastructure/adapters/services/chatgpt-session.service';

export interface ChatGptRegistrationResult {
    hostId: string;
    registration: ChatGptRegistrationSummary | null;
}

/** What `kodus chatgpt login` / `status` need to know about the org's
 *  registration. Never carries a token. Port of OCR `runChatGPTStatus`. */
@Injectable()
export class GetChatGptRegistrationUseCase {
    constructor(
        private readonly sessions: ChatGptSessionService,
        private readonly hostIds: ChatGptHostIdService,
    ) {}

    async execute(organizationId: string): Promise<ChatGptRegistrationResult> {
        const [hostId, registration] = await Promise.all([
            this.hostIds.getOrCreate(),
            this.sessions.registration(organizationId),
        ]);
        return { hostId, registration: registration ?? null };
    }
}
