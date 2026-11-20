/**
 * The `kodus chatgpt` endpoints: RBAC per route, the org taken only from the
 * principal, and 404 everywhere on Kodus Cloud.
 */
jest.mock('@libs/ee/configs/environment', () => ({
    environment: { API_CLOUD_MODE: false },
}));

import { AbilityBuilder, createMongoAbility } from '@casl/ability';
import { NotFoundException } from '@nestjs/common';
import { GUARDS_METADATA } from '@nestjs/common/constants';

import { environment } from '@libs/ee/configs/environment';
import { STATUS } from '@libs/core/infrastructure/config/types/database/status.type';
import {
    Action,
    ResourceType,
} from '@libs/identity/domain/permissions/enums/permissions.enum';
import { AppAbility } from '@libs/identity/domain/permissions/types/permissions.types';
import { PolicyGuard } from '@libs/identity/infrastructure/adapters/services/permissions/policy.guard';
import { ChatGptSignInController } from './chatgpt-sign-in.controller';
import { TenantScopeGuard } from '../guards/tenant-scope.guard';

type Handler = 'host' | 'registration' | 'session' | 'logout' | 'model';

const policiesOf = (handler: Handler) =>
    (Reflect.getMetadata(
        'check_policy',
        ChatGptSignInController.prototype[handler],
    ) ?? []) as Array<(ability: AppAbility, request: any) => boolean>;

const guardsOf = (handler: Handler) =>
    (Reflect.getMetadata(
        GUARDS_METADATA,
        ChatGptSignInController.prototype[handler],
    ) ?? []) as unknown[];

const ability = (can: Array<[Action, ResourceType]>): AppAbility => {
    const builder = new AbilityBuilder<AppAbility>(createMongoAbility);
    for (const [action, resource] of can) {
        builder.can(action, resource, { organizationId: 'org-1' } as any);
    }
    return builder.build();
};

const user = { organization: { uuid: 'org-1' }, status: STATUS.ACTIVE };
const allows = (handler: Handler, a: AppAbility) =>
    policiesOf(handler).every((policy) => policy(a, { user }));

function controller() {
    const calls: Record<string, unknown[]> = {};
    const record =
        (name: string, result: unknown = {}) =>
        (...args: unknown[]) => {
            calls[name] = args;
            return Promise.resolve(result);
        };
    const c = new ChatGptSignInController(
        { execute: record('host', { hostId: 'urn:uuid:x' }) } as any,
        { execute: record('registration') } as any,
        { execute: record('session') } as any,
        { execute: record('logout') } as any,
        { execute: record('model') } as any,
        { user: { organization: { uuid: 'my-org' } } } as any,
    );
    return { c, calls };
}

describe('ChatGptSignInController', () => {
    afterEach(() => {
        (environment as { API_CLOUD_MODE: boolean }).API_CLOUD_MODE = false;
    });

    it('is tenant-scoped at the class level', () => {
        expect(
            Reflect.getMetadata(GUARDS_METADATA, ChatGptSignInController),
        ).toContain(TenantScopeGuard);
    });

    it('host is readable by any member (no PolicyGuard)', () => {
        expect(guardsOf('host')).not.toContain(PolicyGuard);
        expect(policiesOf('host')).toEqual([]);
    });

    it.each<[Handler, Action]>([
        ['registration', Action.Read],
        ['session', Action.Create],
        ['logout', Action.Delete],
        ['model', Action.Create],
    ])('%s needs %s on OrganizationSettings', (handler, action) => {
        expect(guardsOf(handler)).toContain(PolicyGuard);
        expect(
            allows(
                handler,
                ability([[action, ResourceType.OrganizationSettings]]),
            ),
        ).toBe(true);
        expect(
            allows(
                handler,
                ability([[action, ResourceType.CodeReviewSettings]]),
            ),
        ).toBe(false);
    });

    it('takes the organization from the principal only', async () => {
        const { c, calls } = controller();
        await c.registration();
        await c.session({ bundle: {} as any, organizationId: 'victim' } as any);
        await c.logout();
        await c.model({ model: 'gpt-6.1-sol' });
        expect(calls.registration).toEqual(['my-org']);
        expect(calls.session[0]).toBe('my-org');
        expect(calls.logout).toEqual(['my-org']);
        expect(calls.model[0]).toBe('my-org');
    });

    it.each<Handler>(['host', 'registration', 'logout'])(
        '%s answers 404 on Kodus Cloud',
        async (handler) => {
            (environment as { API_CLOUD_MODE: boolean }).API_CLOUD_MODE = true;
            const { c, calls } = controller();
            await expect((c as any)[handler]()).rejects.toBeInstanceOf(
                NotFoundException,
            );
            expect(Object.keys(calls)).toEqual([]);
        },
    );
});
