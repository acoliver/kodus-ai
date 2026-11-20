import {
    BadRequestException,
    Body,
    Controller,
    Delete,
    Get,
    Inject,
    NotFoundException,
    Post,
    UseGuards,
} from '@nestjs/common';
import { REQUEST } from '@nestjs/core';
import { ApiBearerAuth, ApiBody, ApiOperation, ApiTags } from '@nestjs/swagger';

import { UserRequest } from '@libs/core/infrastructure/config/types/http/user-request.type';
import { isChatGptProviderAvailable } from '@libs/core/infrastructure/services/providers/kodus-provider-availability';
import {
    Action,
    ResourceType,
} from '@libs/identity/domain/permissions/enums/permissions.enum';
import {
    CheckPolicies,
    PolicyGuard,
} from '@libs/identity/infrastructure/adapters/services/permissions/policy.guard';
import { checkPermissions } from '@libs/identity/infrastructure/adapters/services/permissions/policy.handlers';
import { GetChatGptHostUseCase } from '@libs/organization/application/use-cases/chatgpt/get-chatgpt-host.use-case';
import { GetChatGptRegistrationUseCase } from '@libs/organization/application/use-cases/chatgpt/get-chatgpt-registration.use-case';
import {
    ImportChatGptSessionInput,
    ImportChatGptSessionUseCase,
} from '@libs/organization/application/use-cases/chatgpt/import-chatgpt-session.use-case';
import { LogoutChatGptSessionUseCase } from '@libs/organization/application/use-cases/chatgpt/logout-chatgpt-session.use-case';
import { SetChatGptModelUseCase } from '@libs/organization/application/use-cases/chatgpt/set-chatgpt-model.use-case';
import { ApiStandardResponses } from '../docs/api-standard-responses.decorator';
import { TenantScopeGuard } from '../guards/tenant-scope.guard';

/**
 * "Sign in with ChatGPT" for self-hosted Kodus, driven by `kodus chatgpt`.
 * The CLI runs the loopback OAuth flow on the admin's machine and uploads the
 * token response here; the server validates it and keeps the session. The org
 * always comes from the authenticated principal, never from the request.
 *
 * Every route answers 404 on Kodus Cloud: the plan is for self-hosted use.
 */
@ApiTags('ChatGPT sign-in')
@ApiBearerAuth('jwt')
@ApiStandardResponses()
@UseGuards(TenantScopeGuard)
@Controller('organization-parameters/byok/chatgpt')
export class ChatGptSignInController {
    constructor(
        private readonly getHost: GetChatGptHostUseCase,
        private readonly getRegistration: GetChatGptRegistrationUseCase,
        private readonly importSession: ImportChatGptSessionUseCase,
        private readonly logoutSession: LogoutChatGptSessionUseCase,
        private readonly setModel: SetChatGptModelUseCase,
        @Inject(REQUEST)
        private readonly request: UserRequest,
    ) {}

    private organizationId(): string {
        if (!isChatGptProviderAvailable()) {
            throw new NotFoundException();
        }
        const organizationId = this.request?.user?.organization?.uuid;
        if (!organizationId) {
            throw new BadRequestException(
                'Organization ID is missing from request',
            );
        }
        return organizationId;
    }

    @Get('/host')
    @ApiOperation({
        summary: 'ChatGPT agent host id',
        description:
            'The deployment host id `kodus chatgpt login` sends as `ext_agent_host_id`. Not a credential.',
    })
    public async host(): Promise<{ hostId: string }> {
        this.organizationId();
        return this.getHost.execute();
    }

    @Get('/registration')
    @UseGuards(PolicyGuard)
    @CheckPolicies(
        checkPermissions({
            action: Action.Read,
            resource: ResourceType.OrganizationSettings,
        }),
    )
    @ApiOperation({
        summary: 'ChatGPT registration status',
        description:
            "The org's ChatGPT registration (client id, account, plan permission, expiry). Never returns tokens.",
    })
    public async registration() {
        return this.getRegistration.execute(this.organizationId());
    }

    @Post('/session')
    @UseGuards(PolicyGuard)
    @CheckPolicies(
        checkPermissions({
            action: Action.Create,
            resource: ResourceType.OrganizationSettings,
        }),
    )
    @ApiBody({
        schema: {
            type: 'object',
            required: ['bundle'],
            properties: {
                bundle: { type: 'object' },
                model: { type: 'string' },
                setDefault: { type: 'boolean' },
                replace: { type: 'boolean' },
            },
        },
    })
    @ApiOperation({
        summary: 'Import a ChatGPT sign-in',
        description:
            'Validate the credential bundle from `kodus chatgpt login` and connect the ChatGPT plan as a BYOK provider.',
    })
    public async session(@Body() body: ImportChatGptSessionInput) {
        return this.importSession.execute(this.organizationId(), body);
    }

    @Delete('/session')
    @UseGuards(PolicyGuard)
    @CheckPolicies(
        checkPermissions({
            action: Action.Delete,
            resource: ResourceType.OrganizationSettings,
        }),
    )
    @ApiOperation({
        summary: 'Sign out of ChatGPT',
        description:
            "Revoke the org's ChatGPT session and clear its tokens; the registration is kept.",
    })
    public async logout() {
        return this.logoutSession.execute(this.organizationId());
    }

    @Post('/model')
    @UseGuards(PolicyGuard)
    @CheckPolicies(
        checkPermissions({
            action: Action.Create,
            resource: ResourceType.OrganizationSettings,
        }),
    )
    @ApiBody({
        schema: {
            type: 'object',
            required: ['model'],
            properties: {
                model: { type: 'string' },
                setDefault: { type: 'boolean' },
            },
        },
    })
    @ApiOperation({
        summary: 'Choose the ChatGPT model',
        description:
            "Set the slug of the org's ChatGPT model entry (passed through unchanged).",
    })
    public async model(@Body() body: { model: string; setDefault?: boolean }) {
        return this.setModel.execute(this.organizationId(), body);
    }
}
