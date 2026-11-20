/**
 * Deployment gate for the `kodus` BYOK provider ("Kodus as the provider").
 *
 * The provider module is always registered — the registry is deployment-blind
 * — but it only makes sense where Kodus's platform accounts and the credit
 * ledger exist: the cloud. On a self-hosted install the id must not appear in
 * the picker, must not list models or probe, and must not be persisted as a
 * credential. Every org-layer surface asks this ONE function, so the rule is
 * stated once.
 *
 * `API_CLOUD_MODE` is compiled into the EE environment (not read from .env at
 * runtime), which is why this lives outside libs/llm: the kernel must stay free
 * of the EE config.
 */
import { environment } from '@libs/ee/configs/environment';
import { BYOKProvider } from '@libs/llm/model-providers';

export function isKodusProviderAvailable(): boolean {
    return environment.API_CLOUD_MODE === true;
}

/**
 * The ChatGPT plan ("Sign in with ChatGPT") is for self-hosted Kodus only: it
 * spends one person's plan, which a multi-tenant cloud must not pool. Unlike
 * the `kodus` gate this is a policy about WHERE the plan may be used, so the
 * token source also refuses to issue tokens when it is false.
 */
export function isChatGptProviderAvailable(): boolean {
    return environment.API_CLOUD_MODE !== true;
}

/** Whether `providerId` is connectable on THIS deployment. `kodus` is
 *  cloud-only and `chatgpt` self-hosted-only; every other registered provider
 *  is always connectable. */
export function isProviderAvailableHere(providerId: string): boolean {
    if (providerId === BYOKProvider.KODUS) return isKodusProviderAvailable();
    if (providerId === BYOKProvider.CHATGPT) {
        return isChatGptProviderAvailable();
    }
    return true;
}
