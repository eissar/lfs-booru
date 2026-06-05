import type { JSX } from 'preact';
import type { GalleryImage } from '@/renderer.tsx';

// TODO: Make fallback tag links include the current filter set when that state is available here.
function tagHref(tag: string): string {
    const search = new URLSearchParams();
    search.append('tags', tag);

    const query = search.toString();
    if (query) return `/gallery?${query}`;

    return '/gallery';
}

function tagFragmentHref(tag: string): string {
    const search = new URLSearchParams();
    search.append('tags', tag);

    const query = search.toString();
    if (query) return `/fragment/gallery-content?${query}`;

    return '/fragment/gallery-content';
}

/**
 * Renders an item card JSX component.
 *
 * @param props Component props.
 * @param props.image Image record to render.
 * @param props.renderOrder Positional index of this card in the server listing.
 *   Used by the client-side masonry layout to restore sort order after column recalculation.
 * @returns The item card JSX element.
 */
export function ItemCard({ image, renderOrder }: { image: GalleryImage; renderOrder?: number }): JSX.Element {
    let thumbSrc = `/image/${image.oid}`;
    if (image.thumbnailOid) thumbSrc = `/image/${image.thumbnailOid}`;

    const imageInspect = `/fragment/inspect/${image.id}`;

    return (
        <article class='masonry-item group' data-image-id={image.id} data-render-order-id={renderOrder}>
            <div class='gallery-card relative overflow-hidden flex flex-col rounded-lg hover-card'>
                <div
                    class='gallery-card-meta block p-4 w-full peer order-2'
                    hx-get={imageInspect}
                    hx-target='#inspector-content'
                    hx-target-error='#toasts-log'
                    hx-swap='innerHTML'
                    data-hx-on-click='booruToggleInspector(true)'
                >
                    <span class='font-medium truncate'>{image.name}</span>
                    <div class='flex flex-wrap gap-2 text-xs mt-2'>
                        {image.tags.map((tag) => {
                            const tagUrl = tagHref(tag);
                            const tagFragmentUrl = tagFragmentHref(tag);
                            return (
                                <span
                                    key={tag}
                                    class='text-xs font-medium px-2 py-1 rounded-full backdrop-blur-sm tag-badge'
                                >
                                    <a
                                        class='image-card-tags'
                                        href={tagUrl}
                                        hx-get={tagFragmentUrl}
                                        hx-include='#filter-bar'
                                        hx-target='.gallery-content'
                                        hx-target-error='#toasts-log'
                                        hx-swap='outerHTML'
                                    >
                                        {tag}
                                    </a>
                                </span>
                            );
                        })}
                    </div>
                </div>
                <img
                    src={thumbSrc}
                    loading='lazy'
                    width={image.width}
                    height={image.height}
                    style={`aspect-ratio: ${image.width}/${image.height}`}
                    class='gallery-card-image transition-transform duration-300 peer-hover:scale-105 order-1'
                />
            </div>
        </article>
    );
}
