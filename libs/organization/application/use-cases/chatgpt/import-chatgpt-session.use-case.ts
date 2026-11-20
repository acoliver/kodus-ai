import { BadRequestException, Inject, Injectable } from '@nestjs/common';

import { OrganizationParametersKey } from '@libs/core/domain/enums';
import { createLogger } from '@libs/core/log/logger';
import type { ChatGptCredentialBundle } from '@libs/llm/providers/chatgpt/session-engine';
import { planEnabled } from '@libs/llm/providers/chatgpt/session-state';
import type { CatalogModel } from '@libs/llm/providers/kernel/types';
import {
    IOrganizationParametersService,
    ORGANIZATION_PARAMETERS_SERVICE_TOKEN,
} from '@libs/organization/domain/organizationParameters/contracts/organizationParameters.service.contract';
import { ChatGptHostIdService } from '@libs/organization/infrastructure/adapters/services/chatgpt-host-id.service';
import { ChatGptSessionService } from '@libs/organization/infrastructure/adapters/services/chatgpt-session.service';
import { CreateOrUpdateOrganizationParametersUseCase } from '../organizationParameters/create-or-update.use-case';
import { mergeChatGptIntoByok, toHttpError } from './chatgpt-byok.util';

export interface ImportChatGptSessionInput {
    bundle: ChatGptCredentialBundle;
    /** Explicit slug; passes through unchanged. Default: the first listed. */
    model?: string;
    setDefault?: boolean;
    /** Overwrite the org's registration with another ChatGPT account. */
    replace?: boolean;
}

export interface ImportChatGptSessionResult {
    credentialId: string;
    modelId?: string;
    model?: string;
    models: Array<{ id: string; name: string }>;
    email?: string;
    planEnabled: boolean;
    firstPlanUse: boolean;
    /** Set when `replace` signed out the previous account. */
    replacedRevocationConfirmed?: boolean;
}

/**
 * Accept a credential bundle from `kodus chatgpt login`: validate it and store
 * the session (`ChatGptSessionService`), then add the secret-free `chatgpt`
 * credential and its model to the org's BYOK config through the ordinary BYOK
 * save, so validation, audit and telemetry are the same as any other provider.
 * Port of OpenCodeReview `Login` (commit half) and `exchange`.
 */
@Injectable()
export class ImportChatGptSessionUseCase {
    private readonly logger = createLogger(ImportChatGptSessionUseCase.name);

    constructor(
        private readonly sessions: ChatGptSessionService,
        private readonly hostIds: ChatGptHostIdService,
        @Inject(ORGANIZATION_PARAMETERS_SERVICE_TOKEN)
        private readonly organizationParameters: IOrganizationParametersService,
        private readonly saveOrganizationParameters: CreateOrUpdateOrganizationParametersUseCase,
    ) {}

    async execute(
        organizationId: string,
        input: ImportChatGptSessionInput,
    ): Promise<ImportChatGptSessionResult> {
        if (!input?.bundle) {
            throw new BadRequestException(
                'A ChatGPT credential bundle is required',
            );
        }
        const hostId = await this.hostIds.getOrCreate();
        const imported = await this.sessions
            .importBundle({
                organizationId,
                bundle: input.bundle,
                hostId,
                replace: input.replace === true,
            })
            .catch((err) => {
                throw toHttpError(err);
            });
        const { state } = imported;
        const enabled = planEnabled(state.scopes);

        try {
            let models: CatalogModel[] = [];
            let model: string | undefined;
            if (enabled) {
                models = await this.sessions.listModels(state.credentialId);
                model = input.model?.trim() || models[0]?.id;
                if (!model) {
                    throw new BadRequestException(
                        'The ChatGPT model catalog is empty; configure an explicit model with --model',
                    );
                }
            }
            const current = await this.organizationParameters.findByKey(
                OrganizationParametersKey.BYOK_CONFIG,
                { organizationId },
            );
            const merged = mergeChatGptIntoByok(current?.configValue, {
                credentialId: state.credentialId,
                accountEmail: state.email,
                model,
                setDefault: input.setDefault === true,
            });
            await this.saveOrganizationParameters.execute(
                OrganizationParametersKey.BYOK_CONFIG,
                merged.config,
                { organizationId },
            );
            return {
                credentialId: state.credentialId,
                modelId: merged.modelId,
                model,
                models: models.map((m) => ({ id: m.id, name: m.name })),
                email: state.email,
                planEnabled: enabled,
                firstPlanUse: imported.firstPlanUse,
                ...(imported.replaced
                    ? {
                          replacedRevocationConfirmed:
                              imported.replaced.revocationConfirmed,
                      }
                    : {}),
            };
        } catch (err) {
            // A registration that never reached the BYOK config is unusable
            // and would be reconciled away later: undo it now, revoking its
            // tokens, and report the original failure.
            if (imported.created) {
                const undone = await this.sessions.remove(state.credentialId);
                this.logger.warn({
                    message:
                        'ChatGPT sign-in rolled back: the BYOK config could not be updated',
                    context: ImportChatGptSessionUseCase.name,
                    error: err,
                    metadata: {
                        organizationId,
                        credentialId: state.credentialId,
                        revocationConfirmed: undone.revocationConfirmed,
                    },
                });
            }
            throw err;
        }
    }
}
