import {
    BadRequestException,
    Inject,
    Injectable,
    NotFoundException,
} from '@nestjs/common';

import { OrganizationParametersKey } from '@libs/core/domain/enums';
import { isByokConfig } from '@libs/llm/byok-config';
import { BYOKProvider } from '@libs/llm/model-providers';
import {
    IOrganizationParametersService,
    ORGANIZATION_PARAMETERS_SERVICE_TOKEN,
} from '@libs/organization/domain/organizationParameters/contracts/organizationParameters.service.contract';
import { ChatGptSessionService } from '@libs/organization/infrastructure/adapters/services/chatgpt-session.service';
import { CreateOrUpdateOrganizationParametersUseCase } from '../organizationParameters/create-or-update.use-case';
import { mergeChatGptIntoByok } from './chatgpt-byok.util';

/**
 * Point the org's ChatGPT model entry at another slug (`kodus chatgpt use`).
 * The slug passes through unchanged: the account catalog is OpenAI's, and the
 * server refuses a slug the account cannot use.
 */
@Injectable()
export class SetChatGptModelUseCase {
    constructor(
        private readonly sessions: ChatGptSessionService,
        @Inject(ORGANIZATION_PARAMETERS_SERVICE_TOKEN)
        private readonly organizationParameters: IOrganizationParametersService,
        private readonly saveOrganizationParameters: CreateOrUpdateOrganizationParametersUseCase,
    ) {}

    async execute(
        organizationId: string,
        input: { model: string; setDefault?: boolean },
    ): Promise<{ modelId: string; model: string }> {
        const model = input?.model?.trim();
        if (!model) throw new BadRequestException('model is required');
        const credentialId =
            await this.sessions.credentialIdFor(organizationId);
        if (!credentialId) {
            throw new NotFoundException(
                'No ChatGPT registration for this organization; run `kodus chatgpt login`',
            );
        }
        const current = await this.organizationParameters.findByKey(
            OrganizationParametersKey.BYOK_CONFIG,
            { organizationId },
        );
        const config = current?.configValue;
        const credential = isByokConfig(config)
            ? config.credentials?.find(
                  (c) =>
                      c?.id === credentialId &&
                      c.provider === BYOKProvider.CHATGPT,
              )
            : undefined;
        if (!credential) {
            throw new NotFoundException(
                'The ChatGPT credential is not in the BYOK config; run `kodus chatgpt login`',
            );
        }
        const merged = mergeChatGptIntoByok(config, {
            credentialId,
            accountEmail: credential.settings?.accountEmail as
                string | undefined,
            model,
            setDefault: input.setDefault === true,
        });
        await this.saveOrganizationParameters.execute(
            OrganizationParametersKey.BYOK_CONFIG,
            merged.config,
            { organizationId },
        );
        return { modelId: merged.modelId, model };
    }
}
