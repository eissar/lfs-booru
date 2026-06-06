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

    // TODO: Make fallback tag links include the current filter set when that state is available here.
    const tagBadges = image.tags.map((tag) => {
        const params = new URLSearchParams();
        params.append('tags', tag);
        const tagUrl = `/gallery?${params.toString()}`;
        const tagFragmentUrl = `/fragment/gallery-content?${params.toString()}`;

        return (
            <span class='text-xs font-medium px-2 py-1 rounded-full backdrop-blur-sm tag-badge' key={tag}>
                <a
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
    });

    if (tagBadges.length === 0) {
        tagBadges.push(<span class='text-xs text-muted'>No tags</span>);
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
                    hx-indicator='#inspector-header-refresh'
                    class='rounded p-1 hover-surface'
                >
                    <img
                        src='https://unpkg.com/heroicons@2.0.18/24/outline/arrow-path.svg'
                        class='h-4 w-4'
                        style='filter: var(--icon-filter);'
                        alt='Refresh'
                    />
                </button>
                <button
                    type='button'
                    id='inspector-header-delete'
                    hx-post='/delete'
                    hx-include='#inspector-content input[name=id]'
                    hx-target={`article[data-image-id="${image.id}"]`}
                    hx-swap='delete'
                    hx-indicator='#inspector-header-delete'
                    class='rounded p-1 hover-surface'
                    {...{
                        'data-hx-on:htmx:before-request':
                            `if(this.dataset.confirmed){delete this.dataset.confirmed;booruRequestMasonryReset?.()}else{event.preventDefault();this.dataset.confirmed='1';setTimeout(()=>delete this.dataset.confirmed,2000)}`,
                        'data-hx-on:htmx:after-request':
                            `if(event.detail.successful)document.getElementById('inspector-content').innerHTML=''`,
                    }}
                >
                    <img
                        src='https://unpkg.com/heroicons@2.0.18/24/outline/trash.svg'
                        class='h-4 w-4'
                        style='filter: var(--icon-filter);'
                        alt='Delete'
                    />
                </button>
                <a
                    id='inspector-header-download'
                    href={`/image/${image.oid}`}
                    download={image.name}
                    class='rounded p-1 hover-surface'
                >
                    <img
                        src='https://unpkg.com/heroicons@2.0.18/24/outline/arrow-down-tray.svg'
                        class='h-4 w-4'
                        style='filter: var(--icon-filter);'
                        alt='Download'
                    />
                </a>
                <a
                    id='inspector-header-open-tab'
                    href={`/image/${image.oid}`}
                    target='_blank'
                    rel='noopener noreferrer'
                    class='rounded p-1 hover-surface'
                >
                    <img
                        src='https://unpkg.com/heroicons@2.0.18/24/outline/arrow-top-right-on-square.svg'
                        class='h-4 w-4'
                        style='filter: var(--icon-filter);'
                        alt='Open in new tab'
                    />
                </a>
            </div>
            <form
                hx-post='/update-metadata'
                hx-target='#inspector-content'
                hx-swap='innerHTML'
                hx-indicator={`#inspector-name-save-${image.id}`}
            >
                <ul class='space-y-4'>
                    <li class='flex flex-col gap-1'>
                        <span class='relative self-start inline-block font-medium text-sm'>
                            Name
                        </span>
                        <div class='flex items-center gap-2'>
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
                            <button
                                type='submit'
                                id={`inspector-name-save-${image.id}`}
                                class='rounded p-1 hover-surface'
                                style='position: relative;'
                            >
                                <img
                                    src='https://unpkg.com/heroicons@2.0.18/24/outline/check.svg'
                                    alt='Save'
                                    class='h-4 w-4'
                                    style='filter: var(--icon-filter);'
                                />
                            </button>
                        </div>
                    </li>
                    <li class='flex flex-col gap-2'>
                        <span class='font-medium shrink-0 flex items-center gap-1'>
                            Tags
                            <button
                                id={`tag-edit-btn-${image.id}`}
                                type='button'
                                class='rounded p-0.5 hover-surface'
                                data-hx-on-click={`
                                    const i = document.getElementById('image-tags-${image.id}');
                                    i.classList.toggle('hidden');
                                    if (!i.classList.contains('hidden')) i.focus();
                                `}
                            >
                                <img
                                    src='https://unpkg.com/heroicons@2.0.18/24/outline/pencil.svg'
                                    class='h-3 w-3'
                                    style='filter: var(--icon-filter);'
                                    alt='Edit tags'
                                />
                            </button>
                        </span>
                        <div class='flex flex-wrap gap-2'>
                            {tagBadges}
                        </div>
                        <input
                            id={`image-tags-${image.id}`}
                            class='hidden flex-1 min-w-0 input-focus-underline text-xs text-muted'
                            type='text'
                            name='tags'
                            defaultValue={image.tags.join(' ')}
                            autoComplete='off'
                            spellcheck={false}
                        />
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
        </section>
    );
}
