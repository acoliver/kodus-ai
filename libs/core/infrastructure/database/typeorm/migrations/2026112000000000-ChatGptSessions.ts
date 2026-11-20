import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Sign in with ChatGPT: the `chatgpt_sessions` table holding each org's
 * rotating ChatGPT tokens (encrypted), and the `chatgpt_agent_host` key in
 * `global_parameters_configkey_enum` for the deployment's agent host id.
 *
 * The tokens live here and not in the BYOK blob because the web writes that
 * blob whole: a save that read it before a refresh rotated the refresh token
 * would write the old one back and end the session. `revision` is the
 * compare-and-swap counter every write checks.
 *
 * The enum value follows the idempotent `DO $$` pattern of
 * `2026111300000000-AddSandboxConcurrencyGlobalParam.ts`.
 */
export class ChatGptSessions2026112000000000 implements MigrationInterface {
    name = 'ChatGptSessions2026112000000000';

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            CREATE TABLE "chatgpt_sessions" (
                "uuid" uuid NOT NULL DEFAULT uuid_generate_v4(),
                "createdAt" TIMESTAMP NOT NULL DEFAULT ('now'::text)::timestamp(6) with time zone,
                "updatedAt" TIMESTAMP NOT NULL DEFAULT ('now'::text)::timestamp(6) with time zone,
                "organization_id" uuid NOT NULL,
                "credential_id" character varying NOT NULL,
                "client_id" character varying NOT NULL,
                "issuer" character varying NOT NULL,
                "subject" character varying NOT NULL,
                "email" character varying,
                "ext_agent_host_id" character varying NOT NULL,
                "access_token" text,
                "refresh_token" text,
                "id_token" text,
                "nonce" character varying,
                "token_type" character varying,
                "scopes" text array NOT NULL DEFAULT '{}',
                "expires_at" TIMESTAMP WITH TIME ZONE,
                "earliest_refresh_at" TIMESTAMP WITH TIME ZONE,
                "pending_refresh" text,
                "identity_error" text,
                "welcomed" boolean NOT NULL DEFAULT false,
                "revision" integer NOT NULL DEFAULT 1,
                CONSTRAINT "PK_chatgpt_sessions_uuid" PRIMARY KEY ("uuid"),
                CONSTRAINT "UQ_chatgpt_sessions_credential_id" UNIQUE ("credential_id"),
                CONSTRAINT "CHK_chatgpt_sessions_issued_client" CHECK ("client_id" <> '' AND "client_id" <> 'dynamic_agent_client')
            )
        `);
        await queryRunner.query(`
            CREATE INDEX "IDX_chatgpt_sessions_org" ON "chatgpt_sessions" ("organization_id")
        `);
        await queryRunner.query(`
            ALTER TABLE "chatgpt_sessions"
            ADD CONSTRAINT "FK_chatgpt_sessions_organization" FOREIGN KEY ("organization_id") REFERENCES "organizations"("uuid") ON DELETE CASCADE ON UPDATE NO ACTION
        `);
        await queryRunner.query(`
            DO $$ BEGIN
                IF EXISTS (SELECT 1 FROM pg_type WHERE typname = 'global_parameters_configkey_enum') THEN
                    IF NOT EXISTS (
                        SELECT 1 FROM pg_enum
                        WHERE enumlabel = 'chatgpt_agent_host'
                        AND enumtypid = (SELECT oid FROM pg_type WHERE typname = 'global_parameters_configkey_enum')
                    ) THEN
                        ALTER TYPE "public"."global_parameters_configkey_enum"
                        ADD VALUE 'chatgpt_agent_host';
                    END IF;
                END IF;
            END $$;
        `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            DO $$ BEGIN
                IF EXISTS (SELECT 1 FROM pg_type WHERE typname = 'global_parameters_configkey_enum') THEN
                    IF EXISTS (
                        SELECT 1 FROM pg_enum
                        WHERE enumlabel = 'chatgpt_agent_host'
                        AND enumtypid = (SELECT oid FROM pg_type WHERE typname = 'global_parameters_configkey_enum')
                    ) THEN
                        DELETE FROM "global_parameters" WHERE "configKey" = 'chatgpt_agent_host';

                        ALTER TYPE "public"."global_parameters_configkey_enum" RENAME TO "global_parameters_configkey_enum_old";

                        EXECUTE (
                            SELECT 'CREATE TYPE "public"."global_parameters_configkey_enum" AS ENUM (' ||
                            string_agg(quote_literal(enumlabel), ', ' ORDER BY enumsortorder) ||
                            ')'
                            FROM pg_enum
                            WHERE enumtypid = (SELECT oid FROM pg_type WHERE typname = 'global_parameters_configkey_enum_old')
                            AND enumlabel <> 'chatgpt_agent_host'
                        );

                        ALTER TABLE "global_parameters"
                        ALTER COLUMN "configKey" TYPE "public"."global_parameters_configkey_enum"
                        USING "configKey"::"text"::"public"."global_parameters_configkey_enum";

                        DROP TYPE "public"."global_parameters_configkey_enum_old";
                    END IF;
                END IF;
            END $$;
        `);
        await queryRunner.query(`
            ALTER TABLE "chatgpt_sessions" DROP CONSTRAINT "FK_chatgpt_sessions_organization"
        `);
        await queryRunner.query(`
            DROP INDEX "public"."IDX_chatgpt_sessions_org"
        `);
        await queryRunner.query(`
            DROP TABLE "chatgpt_sessions"
        `);
    }
}
