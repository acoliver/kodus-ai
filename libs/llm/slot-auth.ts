import { BYOKProvider } from './model-providers';
import { isPlatformFundedProvider } from './platform-funded-provider';
import type { NormalizedModel } from './byok-config';

type AuthMaterial = {
    apiKey?: unknown;
    awsBearerToken?: unknown;
    awsAccessKeyId?: unknown;
    awsSecretAccessKey?: unknown;
};

/** Shared credential presence and Bedrock auth priority; accepts ciphertext too. */
export function byokAuthKind(
    provider: string | undefined,
    material: AuthMaterial | null | undefined,
):
    | 'platform'
    | 'chatgpt-session'
    | 'api-key'
    | 'bedrock-bearer'
    | 'bedrock-iam'
    | undefined {
    const has = (value: unknown) =>
        typeof value === 'string' && value.trim().length > 0;
    if (isPlatformFundedProvider(provider)) return 'platform';
    // The ChatGPT plan's material lives in `chatgpt_sessions`, keyed by the
    // credential id; save-time validation proves the session row exists.
    if (provider === BYOKProvider.CHATGPT) return 'chatgpt-session';
    if (provider === BYOKProvider.AMAZON_BEDROCK) {
        if (has(material?.awsBearerToken)) return 'bedrock-bearer';
        if (has(material?.awsAccessKeyId) && has(material?.awsSecretAccessKey))
            return 'bedrock-iam';
        return undefined;
    }
    return has(material?.apiKey) ? 'api-key' : undefined;
}

export function isByokSlotConfigured(
    slot: Partial<NormalizedModel> | null | undefined,
): boolean {
    return !!slot && byokAuthKind(slot.provider, slot) !== undefined;
}
