import { renderToString } from 'preact-render-to-string';
import { join } from '@std/path';
import type { ImageState } from '@/indexer.ts';
import { ItemsFilter } from '@/index_store.ts';
import { ComponentChildren } from 'preact';
import { ItemCard } from '@/template/ItemCard.tsx';
import PhotoGrid from '@/template/PhotoGridFragment.tsx';
import { GalleryContent, GalleryPage } from '@/template/GalleryPage.tsx';
import Inspector from './template/InspectorFragment.tsx';

/**
 * Image state with the derived index identifier attached.
 */
export type GalleryImage = ImageState & { id: string };

export type ToastVariant = 'error' | 'success' | 'info' | 'warn';

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
        photoGridParam: Parameters<HtmlRenderer['renderCardGrid']>[0];
    }): Promise<string>;

    /**
     * Render an inspector fragment for one image.
     *
     * @param image Image state with identifier to inspect.
     * @returns Rendered HTML fragment.
     */
    renderInspector(image: GalleryImage): Promise<string>;

    /**
     * Render a gallery content fragment.
     *
     * @param input Gallery filter and photo grid state.
     * @returns Rendered gallery content HTML fragment.
     */
    renderGalleryContent(input: {
        filter: ItemsFilter;
        photoGridParam: Parameters<HtmlRenderer['renderCardGrid']>[0];
    }): Promise<string>;

    /**
     * Render a card grid fragment from image records.
     *
     * @param input Photo grid images and pagination state.
     * @returns Rendered card grid HTML fragment.
     */
    renderCardGrid(input: { cards: ComponentChildren; offset: string; hasMore: boolean }): Promise<string>;

    /**
     * Render a toast notification fragment.
     *
     * @param input Toast message and optional variant.
     * @returns Rendered toast HTML fragment.
     */
    renderToast(input: { message: string; variant?: ToastVariant }): Promise<string>;
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
        photoGridParam: Parameters<HtmlRenderer['renderCardGrid']>[0];
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

    /** {@inheritDoc HtmlRenderer.renderGalleryContent} */
    async renderGalleryContent(input: {
        filter: ItemsFilter;
        photoGridParam: Parameters<HtmlRenderer['renderCardGrid']>[0];
    }): Promise<string> {
        return await Promise.resolve(renderToString(
            <GalleryContent
                search={input.filter}
                params={input.photoGridParam}
            />,
        ));
    }

    /** {@inheritDoc HtmlRenderer.renderCardGrid} */
    async renderCardGrid(input: { cards: ComponentChildren; offset: string; hasMore: boolean }): Promise<string> {
        return await Promise.resolve(
            renderToString(<PhotoGrid cards={input.cards} offset={input.offset} hasMore={input.hasMore} />),
        );
    }

    /** {@inheritDoc HtmlRenderer.renderToast} */
    async renderToast(input: { message: string; variant?: ToastVariant }): Promise<string> {
        let variantClass = '';
        if (input.variant === 'error') variantClass = 'booru-toast-error';
        if (input.variant === 'success') variantClass = 'booru-toast-success';
        return await Promise.resolve(
            `<div class="booru-toast ${variantClass}" role="alert"><span>${input.message}</span><button type="button" class="booru-toast-dismiss" hx-on-click="this.closest('.booru-toast').remove()">Dismiss</button></div>`,
        );
    }
}
