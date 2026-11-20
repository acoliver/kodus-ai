/**
 * The cloud-only gate for the `kodus` provider, as every org-layer surface sees
 * it. `environment` is compiled-in, so it is mocked per describe.
 */
jest.mock('@libs/ee/configs/environment', () => ({
    environment: { API_CLOUD_MODE: true },
}));

import { environment } from '@libs/ee/configs/environment';
import { GetByokProvidersUseCase } from '@libs/organization/application/use-cases/organizationParameters/get-byok-providers.use-case';
import {
    isChatGptProviderAvailable,
    isKodusProviderAvailable,
    isProviderAvailableHere,
} from './kodus-provider-availability';
import { ProviderService } from './provider.service';

const setCloud = (on: boolean) => {
    (environment as { API_CLOUD_MODE: boolean }).API_CLOUD_MODE = on;
};

describe('kodus provider availability', () => {
    afterEach(() => setCloud(true));

    it('is available on cloud and hidden on self-hosted; other ids are never gated', () => {
        setCloud(true);
        expect(isKodusProviderAvailable()).toBe(true);
        expect(isProviderAvailableHere('kodus')).toBe(true);
        expect(isProviderAvailableHere('openai')).toBe(true);

        setCloud(false);
        expect(isKodusProviderAvailable()).toBe(false);
        expect(isProviderAvailableHere('kodus')).toBe(false);
        expect(isProviderAvailableHere('openai')).toBe(true);
    });

    it('chatgpt is self-hosted only (the opposite of kodus)', () => {
        setCloud(true);
        expect(isChatGptProviderAvailable()).toBe(false);
        expect(isProviderAvailableHere('chatgpt')).toBe(false);

        setCloud(false);
        expect(isChatGptProviderAvailable()).toBe(true);
        expect(isProviderAvailableHere('chatgpt')).toBe(true);
    });

    it('GetByokProvidersUseCase never offers chatgpt in the web picker (CLI-connected)', async () => {
        setCloud(false);
        const ids = (
            await new GetByokProvidersUseCase().execute('org-1')
        ).providers.map((p) => p.id);
        expect(ids).not.toContain('chatgpt');
        expect(ids).toContain('openai');
    });

    it('ProviderService projects kodus as keyless + auto-listable on cloud', () => {
        setCloud(true);
        const service = new ProviderService();
        expect(service.isProviderSupported('kodus')).toBe(true);
        expect(service.getProvider('kodus')).toMatchObject({
            requiresApiKey: false,
            requiresBaseUrl: false,
            autoListModels: true,
            listsModelsLive: false,
        });
    });

    it('ProviderService drops kodus entirely on self-hosted (listing/probe/save refuse it)', () => {
        setCloud(false);
        const service = new ProviderService();
        expect(service.isProviderSupported('kodus')).toBe(false);
        expect(service.getProvider('kodus')).toBeNull();
        expect(service.getAllProviders().map((p) => p.id)).not.toContain('kodus');
        // Everyone else is untouched.
        expect(service.isProviderSupported('anthropic')).toBe(true);
    });

    it('GetByokProvidersUseCase lists kodus only on cloud (and only for an org the alpha gate allows)', async () => {
        // The alpha gate is a separate layer (kodus-provider-gate.service.spec);
        // here it says yes so the deployment rule alone is under test.
        const allow = { isEnabledFor: jest.fn(async () => true) };
        const useCase = new GetByokProvidersUseCase(allow as any);
        setCloud(true);
        expect((await useCase.execute('org-1')).providers.map((p) => p.id)).toContain('kodus');
        setCloud(false);
        expect((await useCase.execute('org-1')).providers.map((p) => p.id)).not.toContain('kodus');
        // Without a gate the descriptor stays closed even on cloud.
        setCloud(true);
        expect((await new GetByokProvidersUseCase().execute('org-1')).providers.map((p) => p.id)).not.toContain('kodus');
    });
});
