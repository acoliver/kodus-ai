import {
    ChatGptSessionPatch,
    ChatGptSessionRecord,
} from '../interfaces/chatgpt-session-record.interface';

export const CHATGPT_SESSION_REPOSITORY_TOKEN = Symbol.for(
    'ChatGptSessionRepository',
);

export interface IChatGptSessionRepository {
    findByCredentialId(
        credentialId: string,
    ): Promise<ChatGptSessionRecord | undefined>;
    findByOrganizationId(
        organizationId: string,
    ): Promise<ChatGptSessionRecord[]>;
    /** Whether `credentialId` is a session of `organizationId`. The authority
     *  rule for a `chatgpt` BYOK credential: `credential_id` is globally
     *  unique, so one org cannot point at another org's session. */
    existsForOrganization(
        organizationId: string,
        credentialId: string,
    ): Promise<boolean>;
    /** Insert a new row at revision 1. */
    insert(
        record: Omit<ChatGptSessionRecord, 'revision'>,
    ): Promise<ChatGptSessionRecord>;
    /** One `UPDATE ... WHERE uuid = $1 AND revision = $2` that also increments
     *  the revision. True when exactly one row changed. */
    compareAndSwap(
        uuid: string,
        expectedRevision: number,
        patch: ChatGptSessionPatch,
    ): Promise<boolean>;
    delete(uuid: string): Promise<void>;
}
