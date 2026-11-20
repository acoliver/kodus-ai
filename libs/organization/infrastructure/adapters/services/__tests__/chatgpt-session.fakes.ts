/**
 * In-memory stand-ins for the ChatGPT session repository and the Postgres
 * advisory lock, with the semantics the service relies on (CAS on revision,
 * one holder per key across "processes").
 */
import type { IChatGptSessionRepository } from '@libs/organization/domain/chatgpt-session/contracts/chatgpt-session.repository.contract';
import type {
    ChatGptSessionPatch,
    ChatGptSessionRecord,
} from '@libs/organization/domain/chatgpt-session/interfaces/chatgpt-session-record.interface';

export class FakeChatGptSessionRepository implements IChatGptSessionRepository {
    readonly rows = new Map<string, ChatGptSessionRecord>();
    reads = 0;

    async findByCredentialId(credentialId: string) {
        this.reads++;
        const r = [...this.rows.values()].find(
            (x) => x.credentialId === credentialId,
        );
        return r && structuredClone(r);
    }

    async findByOrganizationId(organizationId: string) {
        return [...this.rows.values()]
            .filter((r) => r.organizationId === organizationId)
            .map((r) => structuredClone(r));
    }

    async existsForOrganization(organizationId: string, credentialId: string) {
        return [...this.rows.values()].some(
            (r) =>
                r.organizationId === organizationId &&
                r.credentialId === credentialId,
        );
    }

    async insert(record: Omit<ChatGptSessionRecord, 'revision'>) {
        if (
            [...this.rows.values()].some(
                (r) => r.credentialId === record.credentialId,
            )
        ) {
            throw new Error('duplicate key value violates unique constraint');
        }
        const row = { ...structuredClone(record), revision: 1 };
        this.rows.set(row.uuid, row);
        return structuredClone(row);
    }

    async compareAndSwap(
        uuid: string,
        expectedRevision: number,
        patch: ChatGptSessionPatch,
    ) {
        const row = this.rows.get(uuid);
        if (!row || row.revision !== expectedRevision) return false;
        this.rows.set(uuid, {
            ...row,
            ...structuredClone(patch),
            revision: expectedRevision + 1,
        });
        return true;
    }

    async delete(uuid: string) {
        this.rows.delete(uuid);
    }
}

/** `DistributedLockService.acquire` semantics: null while another holder has
 *  the key, a releasable lock otherwise. */
export class FakeLocks {
    private readonly held = new Set<string>();
    acquires = 0;
    /** Make every acquire fail (another process holds it forever). */
    contended = false;

    async acquire(key: string) {
        this.acquires++;
        if (this.contended || this.held.has(key)) return null;
        this.held.add(key);
        return {
            release: async () => {
                this.held.delete(key);
            },
        };
    }
}
