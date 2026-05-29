import { renderToString } from 'preact-render-to-string';
import type { GalleryImage } from '@/renderer.ts';

/**
 * Renders an item card fragment.
 *
 * @param image Image record to render.
 * @param tags Pre-rendered tag link fragments.
 * @returns The item card HTML fragment string.
 */
export default function itemCard(image: GalleryImage, tags: string): string {
    const imageSrc = `/image/${image.oid}`;
    const thumbSrc = image.thumbnailOid ? `/image/${image.thumbnailOid}` : `/image/${image.oid}`;
    const imageInspect = `/fragment/inspect/${image.oid}`;
    return renderToString(
        <article class="masonry-item group" data-image-id={image.id}>
            <div class="gallery-card relative overflow-hidden flex flex-col rounded-lg hover-card">
                <div class="gallery-card-meta block p-4 w-full peer order-2">
                    <a href={imageSrc}>
                        <span class="font-medium truncate">{image.name}</span>
                    </a>
                    <div class="flex flex-wrap gap-2 text-xs mt-2">
                        {/* deno-lint-ignore react-no-danger */}
                        <span dangerouslySetInnerHTML={{ __html: tags }} />
                    </div>
                </div>
                <img
                    src={thumbSrc}
                    loading="lazy"
                    width={image.width}
                    height={image.height}
                    hx-get={imageInspect}
                    hx-target="#inspector-content"
                    hx-swap="innerHTML"
                    class="gallery-card-image transition-transform duration-300 peer-hover:scale-105 order-1"
                />
            </div>
        </article>,
    );
}
