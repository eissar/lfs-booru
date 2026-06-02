import type { JSX } from 'preact';
import type { GalleryImage } from '@/renderer.tsx';

function tagHref(tag: string): string {
    const search = new URLSearchParams();
    search.append('tags', tag);

    const query = search.toString();
    if (query) return `/gallery?${query}`;

    return '/gallery';
}

/**
 * Renders an item card JSX component.
 *
 * @param props Component props.
 * @param props.image Image record to render.
 * @returns The item card JSX element.
 */
export function ItemCard({ image }: { image: GalleryImage }): JSX.Element {
    let thumbSrc = `/image/${image.oid}`;
    if (image.thumbnailOid) thumbSrc = `/image/${image.thumbnailOid}`;

    const imageInspect = `/fragment/inspect/${image.oid}`;

    return (
        <article class='masonry-item group' data-image-id={image.id}>
            <div class='gallery-card relative overflow-hidden flex flex-col rounded-lg hover-card'>
                <div
                    class='gallery-card-meta block p-4 w-full peer order-2'
                    hx-get={imageInspect}
                    hx-target='#inspector-content'
                    hx-swap='innerHTML'
                    data-hx-on--click="document.getElementById('gallery-main')?.classList.add('inspector-open')"
                >
                    <span class='font-medium truncate'>{image.name}</span>
                    <div class='flex flex-wrap gap-2 text-xs mt-2'>
                        {image.tags.map((tag) => {
                            const tagUrl = tagHref(tag);
                            return (
                                <span
                                    key={tag}
                                    class='text-xs font-medium px-2 py-1 rounded-full backdrop-blur-sm tag-badge'
                                >
                                    <a class='image-card-tags' href={tagUrl}>{tag}</a>
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
