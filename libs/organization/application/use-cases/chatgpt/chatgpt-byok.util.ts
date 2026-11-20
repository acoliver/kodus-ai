import { randomUUID } from 'node:crypto';
import {
    BYOK_SECRET_SETTINGS,
    isByokConfig,
    type BYOKConfig,
    type BYOKCredential,
} from '@libs/llm/byok-config';
import { BYOKProvider } from '@libs/llm/model-providers';
import { ChatGptSessionError } from '@libs/llm/providers/chatgpt/session-engine';
import {
    BadRequestException,
    ConflictException,
    HttpException,
} from '@nestjs/common';

/**
 * Every other credential resubmitted with its secrets blank. The BYOK save
 * keeps the stored ciphertext for a blank field (`encryptOrKeep`), whereas
 * passing the ciphertext back would encrypt it a second time.
 */
function blankSecrets(cred: BYOKCredential): BYOKCredential {
    if (cred.managed) return cred;
    const settings = cred.settings ? { ...cred.settings } : undefined;
    if (settings) {
        for (const field of BYOK_SECRET_SETTINGS) {
            if (field in settings) settings[field] = '';
        }
    }
    return {
        ...cred,
        ...(cred.apiKey !== undefined ? { apiKey: '' } : {}),
        ...(settings ? { settings } : {}),
    };
}

/**
 * The org's BYOK config with its ChatGPT credential (and, when `model` is
 * given, that credential's model) put in. Everything else is carried over;
 * routing gains a default only when there was none, or when asked.
 */
export function mergeChatGptIntoByok(
    existing: unknown,
    args: {
        credentialId: string;
        accountEmail?: string;
        model?: string;
        setDefault: boolean;
    },
): { config: BYOKConfig; modelId?: string } {
    const base: BYOKConfig = isByokConfig(existing)
        ? existing
        : { version: 2, credentials: [], models: [] };
    const credential: BYOKCredential = {
        id: args.credentialId,
        provider: BYOKProvider.CHATGPT,
        settings: args.accountEmail ? { accountEmail: args.accountEmail } : {},
    };
    const credentials = [
        ...(base.credentials ?? [])
            .filter((c) => c?.id !== args.credentialId)
            .map(blankSecrets),
        credential,
    ];
    if (!args.model) {
        return { config: { ...base, credentials } };
    }
    const models = [...(base.models ?? [])];
    const index = models.findIndex(
        (m) => m?.credentialId === args.credentialId,
    );
    const modelId = index >= 0 ? models[index].id : randomUUID();
    if (index >= 0) {
        models[index] = { ...models[index], model: args.model };
    } else {
        models.push({
            id: modelId,
            credentialId: args.credentialId,
            model: args.model,
        });
    }
    const routing = { ...(base.routing ?? {}) };
    if (args.setDefault || !routing.defaultModelId) {
        routing.defaultModelId = modelId;
    }
    return { config: { ...base, credentials, models, routing }, modelId };
}

/** An import the engine refused, as the HTTP error the CLI shows. */
export function toHttpError(err: unknown): unknown {
    if (err instanceof HttpException) return err;
    if (err instanceof ChatGptSessionError) {
        return err.kind === 'conflict'
            ? new ConflictException(err.message)
            : new BadRequestException(err.message);
    }
    return err;
}
