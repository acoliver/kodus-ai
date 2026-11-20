/** A response body larger than the caller's cap. Nothing past the cap is
 *  buffered: the stream is cancelled as soon as the limit is crossed. */
export class BodyTooLargeError extends Error {
    constructor(readonly limit: number) {
        super(`response exceeded the ${limit}-byte size limit`);
        this.name = 'BodyTooLargeError';
    }
}

/** Read a response body as UTF-8, failing once it grows past `limit` bytes. */
export async function readBoundedText(
    response: Response,
    limit: number,
): Promise<string> {
    if (!response.body) return '';
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > limit) {
            await reader.cancel();
            throw new BodyTooLargeError(limit);
        }
        chunks.push(value);
    }
    return Buffer.concat(chunks).toString('utf8');
}
