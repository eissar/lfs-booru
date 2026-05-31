import { renderToString } from 'preact-render-to-string';
import { join } from '@std/path';
import type { ImageState } from '@/indexer.ts';
import { ItemsFilter } from '@/index_store.ts';
import { ComponentChildren } from 'preact';
import { ItemCard } from '@/template/ItemCard.tsx';
import PhotoGrid from '@/template/PhotoGridFragment.tsx';
import { GalleryPage } from '@/template/GalleryPage.tsx';
import Inspector from './template/InspectorFragment.tsx';

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
     * Render a gallery page shell.
     *
     * @param input Gallery page title and filter state.
     * @returns Rendered gallery page HTML.
     */
    renderGalleryPage(input: {
        filter: ItemsFilter;
        /** Page title. */
        title: string;
        photoGridParam: Parameters<HtmlRenderer['renderPhotoGrid']>[0];
    }): Promise<string>;

    /**
     * Render an inspector fragment for one image.
     *
     * @param image Image state with identifier to inspect.
     * @returns Rendered HTML fragment.
     */
    renderInspector(image: GalleryImage): Promise<string>;

    /**
     * Render a photo grid fragment from image records.
     *
     * @param input Photo grid images and pagination state.
     * @returns Rendered photo grid HTML fragment.
     */
    renderPhotoGrid(input: { cards: ComponentChildren; offset: string; hasMore: boolean }): Promise<string>;
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
        // wrap in promise to satisfy signature
        return await Promise.resolve(renderToString(<ItemCard image={image} />));
    }

    /**
     * Render a gallery page.
     *
     * @param input Gallery page title and filter state.
     * @returns Rendered gallery page HTML.
     */
    async renderGalleryPage(input: {
        filter: ItemsFilter;
        /** Page title. */
        title: string;
        photoGridParam: Parameters<HtmlRenderer['renderPhotoGrid']>[0];
    }): Promise<string> {
        return await Promise.resolve(`<!DOCTYPE html>\n${
            renderToString(
                <GalleryPage
                    title={input.title}
                    version={this.version}
                    search={input.filter}
                    params={input.photoGridParam}
                />,
            )
        }`);
    }

    /** {@inheritDoc HtmlRenderer.renderInspector} */
    async renderInspector(image: GalleryImage): Promise<string> {
        return await Promise.resolve(renderToString(
            <Inspector image={image} />,
        ));
    }

    // TODO: rename to renderCardGrid ?
    //
    /** {@inheritDoc HtmlRenderer.renderPhotoGrid}
     * @param input Photo grid images and pagination state.
     */
    async renderPhotoGrid(input: { cards: ComponentChildren; offset: string; hasMore: boolean }): Promise<string> {
        return await Promise.resolve(
            renderToString(<PhotoGrid cards={input.cards} offset={input.offset} hasMore={input.hasMore} />),
        );
    }
}
