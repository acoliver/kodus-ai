import type {
    ChatGptImportRequest,
    ChatGptImportResult,
    ChatGptLogoutResult,
    ChatGptModelTestResult,
    ChatGptRegistrationResponse,
} from '../../types/chatgpt.js';
import { request } from './api-core.js';

type Requester = <T>(endpoint: string, options?: RequestInit) => Promise<T>;

const BASE = '/organization-parameters/byok/chatgpt';

/**
 * The `kodus chatgpt` endpoints, called with the logged-in user's token so the
 * org owner's BYOK permissions apply. Team keys cannot reach them.
 */
export class RealChatGptApi {
    constructor(private readonly requester: Requester = request) {}

    private call<T>(
        userToken: string,
        endpoint: string,
        init: RequestInit = {},
    ): Promise<T> {
        return this.requester<T>(endpoint, {
            ...init,
            headers: { Authorization: `Bearer ${userToken}` },
        });
    }

    host(userToken: string): Promise<{ hostId: string }> {
        return this.call(userToken, `${BASE}/host`);
    }

    registration(userToken: string): Promise<ChatGptRegistrationResponse> {
        return this.call(userToken, `${BASE}/registration`);
    }

    importSession(
        userToken: string,
        body: ChatGptImportRequest,
    ): Promise<ChatGptImportResult> {
        return this.call(userToken, `${BASE}/session`, {
            method: 'POST',
            body: JSON.stringify(body),
        });
    }

    logout(userToken: string): Promise<ChatGptLogoutResult> {
        return this.call(userToken, `${BASE}/session`, { method: 'DELETE' });
    }

    setModel(
        userToken: string,
        body: { model: string; setDefault?: boolean },
    ): Promise<{ modelId: string; model: string }> {
        return this.call(userToken, `${BASE}/model`, {
            method: 'POST',
            body: JSON.stringify(body),
        });
    }

    listModels(
        userToken: string,
    ): Promise<{ models: Array<{ id: string; name: string }> }> {
        return this.call(userToken, '/organization-parameters/list-models', {
            method: 'POST',
            body: JSON.stringify({ provider: 'chatgpt' }),
        });
    }

    /** The connection test: one real review-shaped call on the plan. */
    testModel(
        userToken: string,
        body: { model: string; credentialId?: string },
    ): Promise<ChatGptModelTestResult> {
        return this.call(
            userToken,
            '/organization-parameters/test-byok-model',
            {
                method: 'POST',
                body: JSON.stringify({ provider: 'chatgpt', ...body }),
            },
        );
    }
}

export const chatGptApi = new RealChatGptApi();
