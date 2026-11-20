import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import {
    CHATGPT_ISSUER,
    DYNAMIC_CLIENT,
} from '@libs/llm/providers/chatgpt/constants';
import { IChatGptSessionRepository } from '@libs/organization/domain/chatgpt-session/contracts/chatgpt-session.repository.contract';
import {
    ChatGptSessionPatch,
    ChatGptSessionRecord,
} from '@libs/organization/domain/chatgpt-session/interfaces/chatgpt-session-record.interface';
import { ChatGptSessionModel } from './schemas/chatgpt-session.model';

const orUndefined = <T>(v: T | null): T | undefined =>
    v === null ? undefined : v;
const orNull = <T>(v: T | undefined): T | null => (v === undefined ? null : v);

/** A row this code could not have written means corruption, not a state to
 *  work around: reading it fails (OCR `store.go` load validation). */
function toRecord(m: ChatGptSessionModel): ChatGptSessionRecord {
    if (
        !m.clientId ||
        m.clientId === DYNAMIC_CLIENT ||
        m.issuer !== CHATGPT_ISSUER ||
        !m.subject
    ) {
        throw new Error(`invalid ChatGPT session row ${m.uuid}`);
    }
    return {
        uuid: m.uuid,
        organizationId: m.organizationId,
        credentialId: m.credentialId,
        revision: m.revision,
        clientId: m.clientId,
        issuer: m.issuer,
        subject: m.subject,
        email: orUndefined(m.email),
        extAgentHostId: m.extAgentHostId,
        accessToken: orUndefined(m.accessToken),
        refreshToken: orUndefined(m.refreshToken),
        idToken: orUndefined(m.idToken),
        nonce: orUndefined(m.nonce),
        tokenType: orUndefined(m.tokenType),
        scopes: m.scopes ?? [],
        expiresAt: orUndefined(m.expiresAt),
        earliestRefreshAt: orUndefined(m.earliestRefreshAt),
        pendingRefresh: orUndefined(m.pendingRefresh),
        identityError: orUndefined(m.identityError),
        welcomed: m.welcomed,
    };
}

/** Every mutable column, absent values written as NULL so a cleared token is
 *  actually cleared. */
function toColumns(p: ChatGptSessionPatch) {
    return {
        clientId: p.clientId,
        issuer: p.issuer,
        subject: p.subject,
        email: orNull(p.email),
        extAgentHostId: p.extAgentHostId,
        accessToken: orNull(p.accessToken),
        refreshToken: orNull(p.refreshToken),
        idToken: orNull(p.idToken),
        nonce: orNull(p.nonce),
        tokenType: orNull(p.tokenType),
        scopes: p.scopes,
        expiresAt: orNull(p.expiresAt),
        earliestRefreshAt: orNull(p.earliestRefreshAt),
        pendingRefresh: orNull(p.pendingRefresh),
        identityError: orNull(p.identityError),
        welcomed: p.welcomed,
    };
}

@Injectable()
export class ChatGptSessionRepository implements IChatGptSessionRepository {
    constructor(
        @InjectRepository(ChatGptSessionModel)
        private readonly sessions: Repository<ChatGptSessionModel>,
    ) {}

    async findByCredentialId(
        credentialId: string,
    ): Promise<ChatGptSessionRecord | undefined> {
        const model = await this.sessions.findOne({ where: { credentialId } });
        return model ? toRecord(model) : undefined;
    }

    async findByOrganizationId(
        organizationId: string,
    ): Promise<ChatGptSessionRecord[]> {
        const models = await this.sessions.find({
            where: { organizationId },
            order: { createdAt: 'ASC' },
        });
        return models.map(toRecord);
    }

    async existsForOrganization(
        organizationId: string,
        credentialId: string,
    ): Promise<boolean> {
        return this.sessions.exists({
            where: { organizationId, credentialId },
        });
    }

    async insert(
        record: Omit<ChatGptSessionRecord, 'revision'>,
    ): Promise<ChatGptSessionRecord> {
        const model = this.sessions.create({
            uuid: record.uuid,
            organizationId: record.organizationId,
            credentialId: record.credentialId,
            revision: 1,
            ...toColumns(record),
        });
        return toRecord(await this.sessions.save(model));
    }

    async compareAndSwap(
        uuid: string,
        expectedRevision: number,
        patch: ChatGptSessionPatch,
    ): Promise<boolean> {
        const result = await this.sessions
            .createQueryBuilder()
            .update(ChatGptSessionModel)
            .set({
                ...toColumns(patch),
                revision: () => 'revision + 1',
            })
            .where('uuid = :uuid AND revision = :expectedRevision', {
                uuid,
                expectedRevision,
            })
            .execute();
        return result.affected === 1;
    }

    async delete(uuid: string): Promise<void> {
        await this.sessions.delete({ uuid });
    }
}
