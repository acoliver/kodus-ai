import { Injectable } from '@nestjs/common';

import { ChatGptHostIdService } from '@libs/organization/infrastructure/adapters/services/chatgpt-host-id.service';

/** The deployment's ChatGPT agent host id. Opaque and non-secret ("a host ID
 *  is not an authentication credential"), so any org member may read it to
 *  prepare a bundle with `kodus chatgpt login --output` for an owner. */
@Injectable()
export class GetChatGptHostUseCase {
    constructor(private readonly hostIds: ChatGptHostIdService) {}

    async execute(): Promise<{ hostId: string }> {
        return { hostId: await this.hostIds.getOrCreate() };
    }
}
