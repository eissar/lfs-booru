import { join } from '@std/path';
import type { ImageState } from '@/indexer.ts';
// import { escape } from '@std/html/entities';
import { html } from '@/html.ts';
import { template } from '@/template/index.ts';
import { ItemsFilter } from '@/index_store.ts';

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
        filter: ItemsFilter;
        /** Page title. */
        title: string;
    }): Promise<string>;

    /**
     * Render an inspector fragment for one image.
     *
     * @param image Image state to inspect.
     * @returns Rendered HTML fragment.
     */
    renderInspector(image: ImageState): Promise<string>;

    renderPhotoGrid(input: { cards: string; offset: string; hasMore: boolean }): Promise<string>;
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
     * this does not get cached
     *
     * @param image Image record to render.
     * @returns Rendered HTML fragment.
     */
    async renderImageCard(image: GalleryImage): Promise<string> {
        // TODO: move somewhere or inline
        const renderTagTemplate = (tag: string) => {
            let tagUrl: string = '/gallery';

            const search = new URLSearchParams();
            // should escape tags? or just
            // sanitize in ingest?
            search.append('tags', tag);

            const query = search.toString();
            if (query) tagUrl = `/gallery?${query}`;

            return html`
                <span class="text-xs font-medium px-2 py-1 rounded-full backdrop-blur-sm tag-badge">
                    <a class="image-card-tags" href="${tagUrl}">${tag}</a>
                </span>
            `;
        };

        const tags: string = image.tags.map(renderTagTemplate).join('\n');

        // wrap in promise to satisfy signature
        return await Promise.resolve(template.fragment.ImageCard(image, tags));
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
        filter: ItemsFilter;
        /** Page title. */
        title: string;
    }): Promise<string> {
        const cacheKey = await sha1Hex(JSON.stringify({
            kind: 'gallery-page',
            version: this.version,
            input: input,
        }));
        const cacheDir = join(this.artifactsPath, 'gallery-pages');
        const cachePath = join(cacheDir, `${cacheKey}.html`);

        const cached = await Deno.readTextFile(cachePath).catch((error) => {
            if (error instanceof Deno.errors.NotFound) return null;
            throw error;
        });
        if (cached !== null) return cached;
        const html = template.page.Gallery(input.title, this.version, input.filter);

        await Deno.mkdir(cacheDir, { recursive: true });

        const tmpPath = join(cacheDir, `${cacheKey}.tmp`);
        await Deno.writeTextFile(tmpPath, html);
        await Deno.rename(tmpPath, cachePath).catch(async (error) => {
            await Deno.remove(tmpPath).catch((removeError) => {
                if (!(removeError instanceof Deno.errors.NotFound)) throw removeError;
            });
            throw error;
        });

        return html;
    }

    /** {@inheritDoc HtmlRenderer.renderInspector} */
    async renderInspector(image: ImageState): Promise<string> {
        return await Promise.resolve(template.fragment.inspector(image));
    }

    // TODO: rename to renderCardGrid ?
    //
    /** {@inheritDoc HtmlRenderer.renderPhotoGrid}
     * @param input.offset - how many cards have been served
     */
    async renderPhotoGrid(input: { cards: string; offset: string; hasMore: boolean }): Promise<string> {
        return await Promise.resolve(template.fragment.photoGrid(input.cards, input.offset, input.hasMore));
    }
}

async function sha1Hex(value: string): Promise<string> {
    const hash = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(value));
    return Array.from(new Uint8Array(hash))
        .map((byte) => byte.toString(16).padStart(2, '0'))
        .join('');
}
