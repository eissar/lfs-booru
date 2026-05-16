import { Buffer } from 'node:buffer';

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
        buffer: Buffer,
        contentType: string = 'application/octet-stream',
        status: number = 200,
    ): Response =>
        new Response(
            buffer,
            {
                status: status,
                headers: { 'Content-Type': contentType },
            },
        ),

    error: (
        message: string,
        status: number = 500,
        stage: string = 'UNKNOWN',
    ): Response =>
        new Response(
            `Error: ${message}`,
            {
                status: status,
                headers: {
                    'Content-Type': 'text/plain',
                    'x-thermoptic-failed-at': stage,
                },
            },
        ),
};
