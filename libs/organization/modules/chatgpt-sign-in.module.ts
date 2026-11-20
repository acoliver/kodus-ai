import { Module, forwardRef } from '@nestjs/common';

import { GetChatGptHostUseCase } from '../application/use-cases/chatgpt/get-chatgpt-host.use-case';
import { GetChatGptRegistrationUseCase } from '../application/use-cases/chatgpt/get-chatgpt-registration.use-case';
import { ImportChatGptSessionUseCase } from '../application/use-cases/chatgpt/import-chatgpt-session.use-case';
import { LogoutChatGptSessionUseCase } from '../application/use-cases/chatgpt/logout-chatgpt-session.use-case';
import { SetChatGptModelUseCase } from '../application/use-cases/chatgpt/set-chatgpt-model.use-case';
import { ChatGptSessionModule } from './chatgpt-session.module';
import { OrganizationParametersModule } from './organizationParameters.module';

/** The `kodus chatgpt` endpoints' use cases. Separate from the session module
 *  so the BYOK module can import the sessions without a cycle. */
@Module({
    imports: [
        ChatGptSessionModule,
        forwardRef(() => OrganizationParametersModule),
    ],
    providers: [
        GetChatGptHostUseCase,
        GetChatGptRegistrationUseCase,
        ImportChatGptSessionUseCase,
        LogoutChatGptSessionUseCase,
        SetChatGptModelUseCase,
    ],
    exports: [
        GetChatGptHostUseCase,
        GetChatGptRegistrationUseCase,
        ImportChatGptSessionUseCase,
        LogoutChatGptSessionUseCase,
        SetChatGptModelUseCase,
    ],
})
export class ChatGptSignInModule {}
