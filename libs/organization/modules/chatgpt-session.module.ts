import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { DistributedLockService } from '@libs/core/workflow/infrastructure/distributed-lock.service';
import { CHATGPT_SESSION_REPOSITORY_TOKEN } from '../domain/chatgpt-session/contracts/chatgpt-session.repository.contract';
import { ChatGptSessionRepository } from '../infrastructure/adapters/repositories/chatgpt-session.repository';
import { ChatGptSessionModel } from '../infrastructure/adapters/repositories/schemas/chatgpt-session.model';
import { ChatGptHostIdService } from '../infrastructure/adapters/services/chatgpt-host-id.service';
import {
    CHATGPT_FETCH_TOKEN,
    ChatGptSessionService,
} from '../infrastructure/adapters/services/chatgpt-session.service';

/**
 * ChatGPT plan sessions: the `chatgpt_sessions` store, the deployment host id,
 * and the token source the `chatgpt` provider module asks per request (wired
 * at module init). Imported by every process that runs LLM calls (api and
 * worker) and by the BYOK use cases that validate and reconcile it.
 */
@Module({
    imports: [TypeOrmModule.forFeature([ChatGptSessionModel])],
    providers: [
        {
            provide: CHATGPT_SESSION_REPOSITORY_TOKEN,
            useClass: ChatGptSessionRepository,
        },
        { provide: CHATGPT_FETCH_TOKEN, useFactory: () => fetch },
        DistributedLockService,
        ChatGptSessionService,
        ChatGptHostIdService,
    ],
    exports: [
        CHATGPT_SESSION_REPOSITORY_TOKEN,
        ChatGptSessionService,
        ChatGptHostIdService,
    ],
})
export class ChatGptSessionModule {}
