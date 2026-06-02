import { GalleryImage } from '../renderer.tsx';

/**
 * Renders an inspector details fragment for one image.
 *
 * @param image Image state with identifier to inspect.
 * @returns Inspector details HTML fragment.
 */
export default function Inspector({ image }: { image: GalleryImage }) {
    let thumbSrc = `/image/${image.oid}`;
    if (image.thumbnailOid) thumbSrc = `/image/${image.thumbnailOid}`;

    const tags = image.tags.map((tag) => {
        const params = new URLSearchParams();
        params.append('tags', tag);
        const tagUrl = `/gallery?${params.toString()}`;

        return (
            <span class='text-xs font-medium px-2 py-1 rounded-full backdrop-blur-sm tag-badge' key={tag}>
                <a href={tagUrl}>{tag}</a>
            </span>
        );
    });

    if (tags.length === 0) {
        tags.push(<span class='text-xs text-muted'>No tags</span>);
    }

    return (
        <section class='space-y-4'>
            <input type='hidden' name='id' value={image.id} />
            <img
                src={thumbSrc}
                alt={image.name}
                class='aspect-square w-full rounded-lg object-cover'
            />
            <div class='flex'>
                <p class='text-xs text-muted w-full'>
                    {`${image.width} × ${image.height}\t|\t${image.contentType}`}
                </p>
                <button
                    type='button'
                    id='inspector-header-refresh'
                    hx-get='/regen-thumbnail'
                    hx-include='#inspector-content input[name=id]'
                    hx-target={`article[data-image-id="${image.id}"]`}
                    hx-swap='outerHTML'
                    class='rounded p-1 hover-surface'
                >
                    <img
                        src='https://unpkg.com/heroicons@2.0.18/24/outline/arrow-path.svg'
                        class='h-4 w-4'
                        style='filter: var(--icon-filter);'
                        alt='Refresh'
                    />
                </button>
            </div>
            <form
                hx-post='/update-metadata'
                hx-target='#inspector-content'
                hx-swap='outerHTML'
            >
                <ul class='space-y-4'>
                    <li class='flex flex-col gap-1'>
                        <span class='relative self-start inline-block font-medium text-sm'>
                            Name
                        </span>
                        <form class='flex items-center gap-2'>
                            <input type='hidden' name='id' value={image.id} />
                            <input
                                id={`image-name-${image.id}`}
                                class='flex-1 min-w-0 input-focus-underline text-xs text-muted'
                                type='text'
                                name='name'
                                defaultValue={image.name}
                                required
                                autoComplete='off'
                                spellcheck={false}
                            />
                            <button type='submit' class='rounded p-1 hover-surface'>
                                <img
                                    src='https://unpkg.com/heroicons@2.0.18/24/outline/check.svg'
                                    alt='Save'
                                    class='h-4 w-4'
                                    style='filter: var(--icon-filter);'
                                />
                            </button>
                        </form>
                    </li>
                    <li class='flex flex-col gap-2'>
                        <span class='font-medium shrink-0'>OID</span>
                        <span class='text-xs break-all text-muted'>{image.oid}</span>
                    </li>
                    <li class='flex flex-col gap-2'>
                        <span class='font-medium shrink-0'>Path</span>
                        <span class='text-xs break-all text-muted'>{image.path}</span>
                    </li>
                    <li class='flex flex-col gap-2'>
                        <span class='font-medium shrink-0'>Added</span>
                        <span class='text-xs text-muted'>{image.addedAt}</span>
                    </li>
                    <li class='flex flex-col gap-2'>
                        <span class='font-medium shrink-0'>Modified</span>
                        <span class='text-xs text-muted'>{image.mtime}</span>
                    </li>
                </ul>
            </form>
            <div>
                <h4 class='mb-2 text-sm font-medium'>Tags</h4>
                <div class='flex flex-wrap gap-2'>
                    {tags}
                </div>
            </div>
        </section>
    );
}
