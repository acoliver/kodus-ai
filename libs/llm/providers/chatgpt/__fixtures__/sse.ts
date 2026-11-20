/** Server-sent-event helpers for the chatgpt transport specs. */

export type SseEvent = Record<string, unknown> & { type: string };

export function sseBody(events: SseEvent[]): string {
    return events
        .map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`)
        .join('');
}

export function sseResponse(events: SseEvent[], headers = {}): Response {
    return new Response(sseBody(events), {
        status: 200,
        headers: {
            'content-type': 'text/event-stream',
            'x-request-id': 'req-stream',
            ...headers,
        },
    });
}

export const message = (text: string, id = 'm') => ({
    type: 'message',
    id,
    role: 'assistant',
    status: 'completed',
    content: [{ type: 'output_text', text, annotations: [] }],
});

export function completed(
    output: unknown[],
    usage: Record<string, unknown> = {
        input_tokens: 11,
        output_tokens: 12,
        total_tokens: 23,
        output_tokens_details: { reasoning_tokens: 7 },
    },
): SseEvent {
    return {
        type: 'response.completed',
        response: {
            id: 'resp',
            created_at: 1790000000,
            model: 'gpt-6.1-sol',
            status: 'completed',
            output,
            usage,
        },
    };
}

/** A request body as the SDK would send it for a plain generate call. */
export function sdkBody(
    over: Record<string, unknown> = {},
): Record<string, unknown> {
    return {
        model: 'gpt-6.1-sol',
        input: [
            { role: 'developer', content: 'policy' },
            { role: 'user', content: [{ type: 'input_text', text: 'hello' }] },
        ],
        store: false,
        include: ['reasoning.encrypted_content'],
        ...over,
    };
}
