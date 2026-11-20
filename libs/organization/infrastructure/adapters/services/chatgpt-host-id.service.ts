import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';

import { GlobalParametersKey } from '@libs/core/domain/enums/global-parameters-key.enum';
import { GlobalParametersModel } from '../repositories/schemas/global-parameters.model';

const HOST_ID =
    /^urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** A `urn:uuid:` UUID v4 with the RFC 4122 variant (OCR `store.go` Host). */
export function isChatGptHostId(value: unknown): value is string {
    return typeof value === 'string' && HOST_ID.test(value);
}

/**
 * The deployment's ChatGPT agent host id: one per Kodus deployment (api and
 * workers share one database, so they are one host in OpenAI's sense), kept in
 * `global_parameters` and created on first use. Separate from the telemetry
 * instance id on purpose: telemetry can be opted out and must not be joinable
 * with an OpenAI identifier.
 */
@Injectable()
export class ChatGptHostIdService {
    constructor(private readonly dataSource: DataSource) {}

    async getOrCreate(): Promise<string> {
        return this.dataSource.transaction(async (manager) => {
            // Concurrent first calls (api + worker boot) must agree on one id.
            await manager.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
                'chatgpt-agent-host',
            ]);
            const existing = await manager.findOne(GlobalParametersModel, {
                where: { configKey: GlobalParametersKey.CHATGPT_AGENT_HOST },
            });
            const id = existing
                ? (existing.configValue as { id?: unknown } | null)?.id
                : `urn:uuid:${randomUUID()}`;
            if (!isChatGptHostId(id)) {
                throw new Error('invalid ChatGPT host identifier');
            }
            if (!existing) {
                await manager.save(
                    manager.create(GlobalParametersModel, {
                        configKey: GlobalParametersKey.CHATGPT_AGENT_HOST,
                        configValue: { id },
                        description:
                            'ChatGPT agent host id of this Kodus deployment',
                    }),
                );
            }
            return id;
        });
    }
}
