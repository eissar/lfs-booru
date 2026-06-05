import type { ItemsFilter } from '@/index_store.ts';
import { itemFilterToSearchParams, itemSortParameterMap } from '../../server.ts';
import PhotoGrid from './PhotoGridFragment.tsx';
import { HtmlRenderer } from '../renderer.tsx';

function HiddenInput({ name, value }: { name: string; value: string }) {
    return <input type='hidden' name={name} value={value} />;
}

function renderFilterChipDisplayText(k: string, v: string): string | false {
    if (k === 'tags') {
        return v;
    }
    if (k === 'sort') {
        return `${k}: ${v}`;
    }
    if (k === 'deleted') {
        return `${k}: ${v}`;
    }
    return false;
}

function FilterBar({ f }: { f: ItemsFilter }) {
    const params = itemFilterToSearchParams(f);
    const entries: [string, string][] = [...params];
    const chips = [];

    for (let i = 0; i < entries.length; i++) {
        const [exclKey, exclVal] = entries[i];
        const displayText = renderFilterChipDisplayText(exclKey, exclVal);
        if (!displayText) continue;

        params.delete(exclKey, exclVal);

        let removeUrl = '/gallery';
        let fragmentUrl = '/fragment/gallery-content';

        if (params.size > 0) {
            removeUrl = `/gallery?${params.toString()}`;
            fragmentUrl = `/fragment/gallery-content?${params.toString()}`;
        }

        chips.push(
            <span
                class='filter-chip text-xs font-medium px-2 py-1 rounded-full backdrop-blur-sm tag-badge'
                key={`${exclKey}-${exclVal}`}
            >
                <input type='hidden' name={exclKey} value={exclVal} />
                <a
                    href={removeUrl}
                    hx-get={fragmentUrl}
                    hx-target='.gallery-content'
                    hx-target-error='#toasts-log'
                    hx-swap='outerHTML'
                >
                    #{displayText}×
                </a>
            </span>,
        );

        params.append(exclKey, exclVal);
    }

    return (
        <>
            <HiddenInput name='limit' value={String(f.limit)} />
            {chips}
        </>
    );
}

function InspectorShell() {
    return (
        <aside
            id='inspector'
            class='inspector shrink-0 transition-[width] duration-150 ease-in-out'
        >
            <div class='inspector-inner flex h-full flex-col'>
                <header class='inspector-header shrink-0'>
                    <div class='min-w-0'>
                        <h2 class='truncate text-sm font-semibold'>Inspector</h2>
                        <p class='text-xs text-muted'>Image details</p>
                    </div>
                    <div class='ml-auto flex items-center gap-1'>
                        <button
                            type='button'
                            class='rounded p-1 hover-surface'
                            data-hx-on-click='booruToggleInspector(false)'
                        >
                            <img
                                src='https://unpkg.com/heroicons@2.0.18/24/outline/x-mark.svg'
                                class='h-4 w-4'
                                style='filter: var(--icon-filter);'
                                alt='Close'
                            />
                        </button>
                    </div>
                </header>
                <div
                    id='inspector-content'
                    class='inspector-body min-h-0 flex-1 overflow-y-auto'
                    data-hx-on-after-swap="document.getElementById('gallery-main')?.classList.add('inspector-open')"
                ></div>
            </div>
        </aside>
    );
}

function PageSizeOptions({ limit }: { limit: number }) {
    const options = [...new Set([10, 25, 50, 100, limit])].sort((a, b) => a - b);
    return (
        <>
            {options.map((opt) => (
                <option value={String(opt)} selected={opt === limit}>
                    {String(opt)}
                </option>
            ))}
        </>
    );
}

function SortOptions({ sort }: { sort: ItemsFilter['sort'] }) {
    return (
        <>
            {Object.entries(itemSortParameterMap).map(([parameter, s]) => (
                <option
                    value={parameter}
                    selected={s.field === sort?.field && s.direction === sort?.direction}
                >
                    {parameter}
                </option>
            ))}
        </>
    );
}

/**
 * Renders the replaceable gallery content region.
 *
 * @param props Gallery filter and photo grid state.
 * @returns Gallery content markup.
 */
export function GalleryContent({
    search,
    params,
}: {
    search: ItemsFilter;
    params: Parameters<HtmlRenderer['renderCardGrid']>[0];
}) {
    return (
        <div class='gallery-content'>
            <div id='filter-bar'>
                <FilterBar f={search} />
            </div>
            <div id='gallery-layout' class='layout'>
                <section class='main-content'>
                    <PhotoGrid
                        cards={params.cards}
                        offset={params.offset}
                        hasMore={params.hasMore}
                    />
                </section>
            </div>
        </div>
    );
}

// initial page load
export function GalleryPage({
    title,
    version,
    search,
    params,
}: {
    title: string;
    version: string;
    search: ItemsFilter;
    params: Parameters<HtmlRenderer['renderCardGrid']>[0];
}) {
    const hiddenTagInputs = search?.tags?.map((tag) => <HiddenInput key={tag} name='tags' value={tag} />);

    return (
        <html lang='en'>
            <head>
                <meta charset='utf-8' />
                <meta name='viewport' content='width=device-width, initial-scale=1' />
                <title>{title}</title>
                <script src='https://unpkg.com/htmx.org@2.0.4/dist/htmx.min.js'></script>
                <script src='https://cdn.jsdelivr.net/npm/htmx-ext-response-targets@2.0.4'></script>
                <script src='https://cdn.tailwindcss.com'></script>
                <link rel='preconnect' href='https://fonts.googleapis.com' />
                <link rel='preconnect' href='https://fonts.gstatic.com' crossOrigin='anonymous' />
                <link
                    href='https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap'
                    rel='stylesheet'
                />
                <link href='/static/gallery.css' rel='stylesheet' />
                <script src='/static/gallery.js'></script>
            </head>
            <body data-renderer-version={version} class='antialiased' hx-ext='response-targets'>
                <header
                    id='toolbar'
                    class='sticky top-0 z-20 backdrop-blur-lg'
                    style='background-color: var(--bg-surface); border-bottom: 1px solid var(--border-color-light);'
                >
                    <div class='px-4 sm:px-6 lg:px-8 flex items-center h-16'>
                        <div class='gallery-view-controls mr-auto' aria-label='Gallery view'>
                            <input
                                class='gallery-view-input'
                                type='radio'
                                name='gallery-view'
                                id='gallery-view-masonry'
                                value='masonry'
                                checked
                            />
                            <input
                                class='gallery-view-input'
                                type='radio'
                                name='gallery-view'
                                id='gallery-view-grid'
                                value='grid'
                            />
                            <input
                                class='gallery-view-input'
                                type='radio'
                                name='gallery-view'
                                id='gallery-view-list'
                                value='list'
                            />
                            <label class='gallery-view-label' for='gallery-view-masonry'>Masonry</label>
                            <label class='gallery-view-label' for='gallery-view-grid'>Grid</label>
                            <label class='gallery-view-label' for='gallery-view-list'>List</label>
                        </div>

                        <div class='flex items-center gap-4 text-sm flex-1 min-w-0 justify-end ml-auto'>
                            <form
                                id='search-form'
                                method='get'
                                action='/gallery'
                                class='flex items-center h-10 gap-2 w-full max-w-xs flex-shrink-0'
                            >
                                <input
                                    id='search-input'
                                    type='search'
                                    name='q'
                                    placeholder='Search...'
                                    class='block w-full h-full border border-transparent rounded-lg px-4 input-field'
                                    required
                                />
                                {hiddenTagInputs}
                                <button
                                    type='submit'
                                    class='h-full px-4 rounded-md bg-indigo-600 text-white font-medium hover:bg-indigo-700 focus-ring'
                                >
                                    Search
                                </button>
                            </form>
                            <div class='relative inline-block'>
                                {/* @ts-expect-error name attr supported on <details> but missing from React types */}
                                <details class='relative' name='header'>
                                    <summary
                                        id='settings-button'
                                        class='p-2 rounded cursor-pointer list-none hover-surface focus-ring'
                                    >
                                        <img
                                            src='https://unpkg.com/heroicons@2.0.13/24/outline/cog.svg'
                                            class='h-5 w-5'
                                            style='filter: var(--icon-filter);'
                                            alt='Settings'
                                        />
                                    </summary>
                                    <div
                                        class='absolute right-0 mt-2 w-64 rounded shadow-lg z-10 dropdown-container'
                                        style='background-color: var(--bg-surface);'
                                    >
                                        <form
                                            id='preferences'
                                            method='get'
                                            action='/gallery'
                                            hx-get='/fragment/gallery-content'
                                            hx-target='.gallery-content'
                                            hx-target-error='#toasts-log'
                                            hx-swap='outerHTML'
                                            hx-include='#filter-bar'
                                            class='p-4 rounded-md space-y-3'
                                        >
                                            <label class='block text-sm font-medium' for='page-size-input'>
                                                Page size
                                            </label>
                                            <select
                                                id='page-size-input'
                                                name='limit'
                                                class='block w-full border border-transparent rounded-lg py-2 px-3 input-field focus-ring'
                                            >
                                                <PageSizeOptions limit={search.limit} />
                                            </select>
                                            <label class='block text-sm font-medium' for='sort-input'>
                                                Sort
                                            </label>
                                            <select
                                                id='sort-input'
                                                name='sort'
                                                class='block w-full border border-transparent rounded-lg py-2 px-3 input-field focus-ring'
                                            >
                                                <SortOptions sort={search.sort} />
                                            </select>
                                            <button
                                                type='submit'
                                                class='w-full py-2 px-4 rounded-md bg-indigo-600 text-white font-medium hover:bg-indigo-700 focus-ring'
                                            >
                                                Apply
                                            </button>
                                        </form>
                                    </div>
                                </details>
                            </div>
                            <div class='relative inline-block'>
                                <button
                                    type='button'
                                    id='dark-mode-toggle'
                                    class='p-2 rounded cursor-pointer hover-surface focus-ring'
                                >
                                    <img
                                        class='h-5 w-5 sun-icon'
                                        src='https://unpkg.com/heroicons@2.0.18/24/outline/sun.svg'
                                        style='filter: var(--icon-filter);'
                                    />
                                    <img
                                        class='h-5 w-5 moon-icon'
                                        src='https://unpkg.com/heroicons@2.0.18/24/outline/moon.svg'
                                        style='filter: var(--icon-filter);'
                                    />
                                </button>
                            </div>
                            <div class='relative inline-block'>
                                <button
                                    id='inspector-toggle'
                                    type='button'
                                    class='p-2 rounded cursor-pointer hover-surface focus-ring'
                                    data-hx-on-click='booruToggleInspector()'
                                >
                                    <img
                                        src='https://unpkg.com/heroicons@2.0.18/24/outline/information-circle.svg'
                                        class='h-5 w-5'
                                        style='filter: var(--icon-filter);'
                                        alt='Inspector'
                                    />
                                </button>
                            </div>
                            <div class='relative inline-block'>
                                {/* @ts-expect-error name attr supported on <details> but missing from React types */}
                                <details class='relative' name='header'>
                                    <summary
                                        id='upload-button'
                                        aria-haspopup='true'
                                        class='p-2 rounded cursor-pointer list-none hover-surface focus-ring'
                                    >
                                        <img
                                            src='https://unpkg.com/heroicons@2.0.13/24/outline/arrow-up-tray.svg'
                                            class='h-5 w-5'
                                            style='filter: var(--icon-filter);'
                                            alt='Upload'
                                        />
                                    </summary>
                                    <div
                                        class='absolute right-0 mt-2 w-96 rounded shadow-lg z-10 overflow-auto dropdown-container max-h-80'
                                        style='-ms-overflow-style:none; scrollbar-width:none; background-color: var(--bg-surface);'
                                    >
                                        <form
                                            id='upload-form'
                                            hx-post='/ingest'
                                            hx-encoding='multipart/form-data'
                                            hx-target='#toasts-log'
                                            hx-target-error='#toasts-log'
                                            hx-swap='beforeend'
                                            data-hx-on-dragover="event.preventDefault(); this.classList.add('opacity-75', 'outline-dashed', 'outline-2', 'outline-indigo-500')"
                                            data-hx-on-dragleave="event.preventDefault(); this.classList.remove('opacity-75', 'outline-dashed', 'outline-2', 'outline-indigo-500')"
                                            data-hx-on-drop="event.preventDefault(); this.classList.remove('opacity-75', 'outline-dashed', 'outline-2', 'outline-indigo-500'); if(event.dataTransfer.files.length > 0) document.getElementById('file-input').files = event.dataTransfer.files;"
                                            class='p-4 rounded-md transition-all duration-200'
                                        >
                                            <input
                                                type='file'
                                                name='image'
                                                id='file-input'
                                                class='block w-full text-sm text-muted file:mr-4 file:py-2 file:px-4 file:rounded file:border-0 file:text-sm file:font-medium file:bg-indigo-50 file:text-indigo-700 hover:file:bg-indigo-100 mb-4'
                                                required
                                            />
                                            <button
                                                type='submit'
                                                id='submit-button'
                                                class='w-full py-2 px-4 rounded-md bg-indigo-600 text-white font-medium hover:bg-indigo-700 focus-ring'
                                            >
                                                Upload
                                            </button>
                                        </form>
                                    </div>
                                </details>
                            </div>
                        </div>
                    </div>
                </header>
                <main id='gallery-main' class='gallery-main main-scroll'>
                    <script>
                        {`try{if(localStorage.getItem('inspector-open')==='true')document.getElementById('gallery-main')?.classList.add('inspector-open')}catch(_){}`}
                    </script>
                    <GalleryContent search={search} params={params} />
                    <InspectorShell />
                </main>
                <div id='toasts-log' />
            </body>
        </html>
    );
}
