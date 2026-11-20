import { Column, Entity, Index, JoinColumn, ManyToOne } from 'typeorm';

import { CoreModel } from '@libs/core/infrastructure/repositories/model/typeOrm';
import { OrganizationModel } from './organization.model';

/**
 * One org's ChatGPT sign-in ("Sign in with ChatGPT"). Token columns and
 * `pending_refresh` hold ciphertext (`@libs/common/utils/crypto`); only
 * `ChatGptSessionService` decrypts them. `revision` is the compare-and-swap
 * counter every write checks.
 */
@Entity('chatgpt_sessions')
@Index('IDX_chatgpt_sessions_org', ['organizationId'])
export class ChatGptSessionModel extends CoreModel {
    @Column({ name: 'organization_id', type: 'uuid' })
    organizationId: string;

    @ManyToOne(() => OrganizationModel, { onDelete: 'CASCADE' })
    @JoinColumn({ name: 'organization_id', referencedColumnName: 'uuid' })
    organization?: OrganizationModel;

    @Column({ name: 'credential_id', unique: true })
    credentialId: string;

    @Column({ name: 'client_id' })
    clientId: string;

    @Column()
    issuer: string;

    @Column()
    subject: string;

    @Column({ type: 'varchar', nullable: true })
    email: string | null;

    @Column({ name: 'ext_agent_host_id' })
    extAgentHostId: string;

    @Column({ name: 'access_token', type: 'text', nullable: true })
    accessToken: string | null;

    @Column({ name: 'refresh_token', type: 'text', nullable: true })
    refreshToken: string | null;

    @Column({ name: 'id_token', type: 'text', nullable: true })
    idToken: string | null;

    @Column({ type: 'varchar', nullable: true })
    nonce: string | null;

    @Column({ name: 'token_type', type: 'varchar', nullable: true })
    tokenType: string | null;

    @Column({ type: 'text', array: true, default: () => "'{}'" })
    scopes: string[];

    @Column({ name: 'expires_at', type: 'timestamptz', nullable: true })
    expiresAt: Date | null;

    @Column({
        name: 'earliest_refresh_at',
        type: 'timestamptz',
        nullable: true,
    })
    earliestRefreshAt: Date | null;

    @Column({ name: 'pending_refresh', type: 'text', nullable: true })
    pendingRefresh: string | null;

    @Column({ name: 'identity_error', type: 'text', nullable: true })
    identityError: string | null;

    @Column({ type: 'boolean', default: false })
    welcomed: boolean;

    @Column({ type: 'integer', default: 1 })
    revision: number;
}
