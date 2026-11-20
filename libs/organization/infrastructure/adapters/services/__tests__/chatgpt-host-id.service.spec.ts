/**
 * The deployment host id: created once under an advisory lock, reused, and
 * validated as OpenCodeReview validates `host.json` (`store.go` Host).
 */
import { GlobalParametersKey } from '@libs/core/domain/enums/global-parameters-key.enum';
import {
    ChatGptHostIdService,
    isChatGptHostId,
} from '../chatgpt-host-id.service';

/** A DataSource whose transactions serialize on the advisory lock the
 *  service takes, over one in-memory global_parameters table. */
function fakeDataSource(initial?: unknown) {
    const rows: Array<{ configKey: string; configValue: unknown }> = [];
    if (initial !== undefined) {
        rows.push({
            configKey: GlobalParametersKey.CHATGPT_AGENT_HOST,
            configValue: initial,
        });
    }
    let chain = Promise.resolve();
    const locks: string[] = [];
    const dataSource = {
        transaction: async (fn: (manager: any) => Promise<unknown>) => {
            let release!: () => void;
            const previous = chain;
            chain = new Promise<void>((r) => (release = r));
            const manager = {
                query: async (_sql: string, params: string[]) => {
                    locks.push(params[0]);
                    await previous;
                },
                findOne: async (_model: unknown, opts: any) =>
                    rows.find((r) => r.configKey === opts.where.configKey) ??
                    null,
                create: (_model: unknown, value: any) => value,
                save: async (value: any) => {
                    await new Promise((r) => setTimeout(r, 5));
                    rows.push(value);
                    return value;
                },
            };
            try {
                return await fn(manager);
            } finally {
                release();
            }
        },
    };
    return { dataSource, rows, locks };
}

describe('ChatGptHostIdService', () => {
    it('creates a urn:uuid v4 once and reuses it', async () => {
        const { dataSource, rows, locks } = fakeDataSource();
        const service = new ChatGptHostIdService(dataSource as any);
        const first = await service.getOrCreate();
        expect(isChatGptHostId(first)).toBe(true);
        await expect(service.getOrCreate()).resolves.toBe(first);
        expect(rows).toHaveLength(1);
        expect(locks).toEqual(['chatgpt-agent-host', 'chatgpt-agent-host']);
    });

    it('concurrent first calls agree on one id', async () => {
        const { dataSource, rows } = fakeDataSource();
        const service = new ChatGptHostIdService(dataSource as any);
        const ids = await Promise.all(
            Array.from({ length: 5 }, () => service.getOrCreate()),
        );
        expect(new Set(ids).size).toBe(1);
        expect(rows).toHaveLength(1);
    });

    it.each([
        { id: 'bad' },
        { id: '00000000-0000-4000-8000-000000000000' },
        { id: 'urn:uuid:00000000-0000-1000-8000-000000000000' },
        { id: 'urn:uuid:00000000-0000-4000-c000-000000000000' },
        null,
    ])('rejects a stored host record %j', async (stored) => {
        const { dataSource } = fakeDataSource(stored);
        await expect(
            new ChatGptHostIdService(dataSource as any).getOrCreate(),
        ).rejects.toThrow('invalid ChatGPT host identifier');
    });
});
