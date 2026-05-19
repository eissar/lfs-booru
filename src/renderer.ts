import { join } from '@std/path';
import type { ImageState } from './indexer.ts';
import { escape } from '@std/html/entities';
import { html } from 'htm/preact';

/**
 * Image state with the derived index identifier attached.
 */
export type GalleryImage = ImageState & { id: string };

/**
 * Renders gallery HTML artifacts from derived image data.
 */
export interface HtmlRenderer {
    /** Renderer/template version used for cache invalidation. */
    readonly version: string;

    /**
     * Render one image card fragment.
     *
     * @param image Image record to render.
     * @returns Rendered HTML fragment.
     */
    renderImageCard(image: GalleryImage): Promise<string>;

    /**
     * Render a gallery page from pre-rendered card fragments.
     *
     * @param input Gallery page title and card fragments.
     * @returns Rendered gallery page HTML.
     */
    renderGalleryPage(input: {
        title: string;
        cards: string[];
    }): Promise<string>;
}

/**
 * File-backed HTML renderer that stores rendered artifacts under a library index.
 */
export class CachingHtmlRenderer implements HtmlRenderer {
    /** Renderer/template version used for cache invalidation. */
    readonly version: string = 'default';

    private readonly artifactsPath: string;

    /**
     * Create a renderer that caches HTML artifacts below `index/artifacts`.
     *
     * @param libraryRootPath Library root path.
     * @param options Optional renderer settings.
     * @returns File-backed caching renderer.
     */
    constructor(
        libraryRootPath: string,
        options: { version?: string; artifactsPath?: string } = {},
    ) {
        this.version = options.version ?? this.version;
        this.artifactsPath = options.artifactsPath ?? join(libraryRootPath, 'index', 'artifacts');
    }

    /**
     * Render one image card fragment.
     *
     * @param image Image record to render.
     * @returns Rendered HTML fragment.
     */
    renderImageCard(image: GalleryImage): Promise<string> {
        const tags = image.tags.length === 0 ? 'none' : image.tags.map((tag) => escape(tag)).join(', ');

        return Promise.resolve(html`
            <div style="border: 1px solid #ccc; padding: 10px; max-width: 350px;">
                <p><strong>${escape(image.name)}</strong></p>
                <p>Tags: ${tags}</p>
                <p>${image.width}×${image.height}</p>
                <img src="/image/${encodeURIComponent(image.oid)}" style="max-width: 300px;" />
            </div>
        `);
    }

    /**
     * Render and cache a gallery page under `index/artifacts/gallery-pages`.
     *
     * Cache identity includes the renderer version, page title, and exact card
     * fragments. If a matching artifact exists, the cached HTML is returned
     * without rendering or rewriting it.
     *
     * @param input Gallery page title and pre-rendered image card fragments.
     * @returns Rendered gallery page HTML.
     */
    async renderGalleryPage(input: {
        title: string;
        cards: string[];
    }): Promise<string> {
        const cacheKey = await sha256Hex(JSON.stringify({
            kind: 'gallery-page',
            version: this.version,
            title: input.title,
            cards: input.cards,
        }));
        const cacheDir = join(this.artifactsPath, 'gallery-pages');
        const cachePath = join(cacheDir, `${cacheKey}.html`);

        const cached = await Deno.readTextFile(cachePath).catch((error) => {
            if (error instanceof Deno.errors.NotFound) return null;
            throw error;
        });
        if (cached !== null) return cached;

        const html = renderGalleryPageTemplate(input.title, input.cards, this.version);
        await Deno.mkdir(cacheDir, { recursive: true });

        const tmpPath = join(cacheDir, `${cacheKey}.${crypto.randomUUID()}.tmp`);
        await Deno.writeTextFile(tmpPath, html);
        await Deno.rename(tmpPath, cachePath).catch(async (error) => {
            await Deno.remove(tmpPath).catch((removeError) => {
                if (!(removeError instanceof Deno.errors.NotFound)) throw removeError;
            });
            throw error;
        });

        return html;
    }
}

function renderGalleryPageTemplate(
    title: string,
    cards: string[],
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
                <div style="display: flex; gap: 20px; flex-wrap: wrap;">
                    ${cards.join('\n')}
                </div>
            </body>
        </html>
    `;
}

async function sha256Hex(value: string): Promise<string> {
    const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
    return Array.from(new Uint8Array(hash))
        .map((byte) => byte.toString(16).padStart(2, '0'))
        .join('');
}
