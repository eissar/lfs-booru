import { STATUS_CODE as Status } from 'jsr:@std/http/status';

/**
 * Print an error message to stderr and terminate the process.
 *
 * @param message Human-readable panic description.
 * @param code Process exit code (defaults to 1).
 * @returns Never returns; the process exits.
 */
export function panic(message: string, code = 1): never {
    console.error(`Panic: ${message}`);
    Deno.exit(code);
}

export const isInt = Number.isSafeInteger as (v: unknown) => v is number;

/** Utility functions for creating HTTP response objects. */
export const c = {
    json: (data: Parameters<JSON['stringify']>[0], status: number = Status.OK): Response =>
        new Response(
            JSON.stringify(data),
            {
                status: status,
                headers: { 'Content-Type': 'application/json' },
            },
        ),

    text: (text: string, status: number = Status.OK): Response =>
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
        status: number = Status.OK,
    ): Response =>
        new Response(
            new Uint8Array(buffer),
            {
                status: status,
                headers: { 'Content-Type': contentType },
            },
        ),

    html: (html: string, status: number = Status.OK, headers: HeadersInit = {}): Response =>
        new Response(
            html,
            {
                status,
                headers: { 'Content-Type': 'text/html; charset=utf-8', ...headers },
            },
        ),

    error: (
        message: string,
        status: number = Status.InternalServerError,
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

    redirect: (location: string | URL, status: number = Status.Found): Response => {
        return Response.redirect(location, status);
    },
};
