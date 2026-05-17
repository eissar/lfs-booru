export function panic(message: string, code = 1): never {
    console.error(`Panic: ${message}`);
    Deno.exit(code);
}

/**
 * Utility functions for creating HTTP response objects
 * @namespace
 */
export const c = {
    json: (data: Parameters<JSON['stringify']>, status: number = 200): Response =>
        new Response(
            JSON.stringify(data),
            {
                status: status,
                headers: { 'Content-Type': 'application/json' },
            },
        ),

    text: (text: string, status: number = 200): Response =>
        new Response(
            text,
            {
                status: status,
                headers: { 'Content-Type': 'text/plain' },
            },
        ),

    blob: (
        buffer: Uint8Array,
        contentType: string = 'application/octet-stream',
        status: number = 200,
    ): Response =>
        new Response(
            new Uint8Array(buffer),
            {
                status: status,
                headers: { 'Content-Type': contentType },
            },
        ),

    error: (
        message: string,
        status: number = 500,
    ): Response =>
        new Response(
            `Error: ${message}`,
            {
                status: status,
                headers: {
                    'Content-Type': 'text/plain',
                },
            },
        ),
};
