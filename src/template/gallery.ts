import { escape } from '@std/html/entities';
import { html } from '@/html.ts';

export default function gallery(
    title: string,
    version: string,
): string {
    const escapedTitle = escape(title);
    const escapedVersion = escape(version);

    return html`
        <!DOCTYPE html>
        <html lang="en">
            <head>
                <meta charset="utf-8">
                <meta name="viewport" content="width=device-width, initial-scale=1">
                <title>${escapedTitle}</title>
            </head>
            <body data-renderer-version="${escapedVersion}">
                <h1>${escapedTitle}</h1>
                <div></div>
            </body>
        </html>
    `;
}
