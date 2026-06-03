import { renderToString } from 'preact-render-to-string';
import type { ItemsFilter } from '@/index_store.ts';
import { itemFilterToSearchParams, itemSortParameterMap } from '../../server.ts';

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
        let fragmentUrl = '/fragment/items';

        if (params.size > 0) {
            removeUrl = `/gallery?${params.toString()}`;
            fragmentUrl = `/fragment/items?${params.toString()}`;
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
                    hx-target='#photo-grid'
                    hx-swap='outerHTML'
                    hx-push-url={removeUrl}
                    data-hx-on--after-request="if (event.detail.successful) event.currentTarget.closest('.filter-chip').remove()"
                >
                    #{displayText}×
                </a>
            </span>,
        );

        params.append(exclKey, exclVal);
    }

    return <>{chips}</>;
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
                            id='inspector-header-refresh'
                            hx-get='/regen-thumbnail'
                            hx-include='#inspector-content input[name=oid]'
                            hx-target='#inspector-content'
                            hx-swap='innerHTML'
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
                            class='inspector-close rounded px-2 py-1 text-sm font-medium hover-surface'
                            data-hx-on--click="document.getElementById('gallery-main')?.classList.remove('inspector-open')"
                        >
                            ×
                        </button>
                    </div>
                </header>
                <div
                    id='inspector-content'
                    class='inspector-body min-h-0 flex-1 overflow-y-auto'
                    data-hx-on--after-swap="document.getElementById('gallery-main')?.classList.add('inspector-open')"
                >
                    <p class='text-xs text-muted'>Select an image to inspect it.</p>
                </div>
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

function GalleryPage({
    title,
    version,
    search,
}: {
    title: string;
    version: string;
    search: ItemsFilter;
}) {
    const hiddenTagInputs = search?.tags?.map((tag) => <HiddenInput key={tag} name='tags' value={tag} />);

    return (
        <html lang='en'>
            <head>
                <meta charset='utf-8' />
                <meta name='viewport' content='width=device-width, initial-scale=1' />
                <title>{title}</title>
                <script src='https://unpkg.com/htmx.org@2.0.4/dist/htmx.min.js'></script>
                <script src='https://cdn.tailwindcss.com'></script>
                <link rel='preconnect' href='https://fonts.googleapis.com' />
                <link rel='preconnect' href='https://fonts.gstatic.com' crossOrigin='anonymous' />
                <link
                    href='https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap'
                    rel='stylesheet'
                />
                <link href='/static/gallery.css' rel='stylesheet' />
                <script
                    // deno-lint-ignore react-no-danger
                    dangerouslySetInnerHTML={{
                        __html: `(function () {
    const savedTheme = localStorage.getItem('theme');
    const isDarkMode = savedTheme ? savedTheme === 'dark' : window.matchMedia('(prefers-color-scheme: dark)').matches;
    document.documentElement.setAttribute('data-theme', isDarkMode ? 'dark' : 'light');
    document.addEventListener('DOMContentLoaded', function () {
        const toggle = document.getElementById('dark-mode-toggle');
        if (toggle) {
            toggle.addEventListener('click', function () {
                const currentTheme = document.documentElement.getAttribute('data-theme');
                const newTheme = currentTheme === 'dark' ? 'light' : 'dark';
                document.documentElement.setAttribute('data-theme', newTheme);
                localStorage.setItem('theme', newTheme);
            });
        }
    });
})();

document.addEventListener('click', function (event) {
    const details = document.querySelectorAll('details');
    details.forEach(detail => {
        if (!detail.contains(event.target)) {
            detail.open = false;
        }
    });
});

document.addEventListener('DOMContentLoaded', function () {
    const viewInputs = document.querySelectorAll('input[name="gallery-view"]');
    const views = new Set(['masonry', 'grid', 'list']);
    const requestedView = new URLSearchParams(window.location.search).get('view');
    if (requestedView && views.has(requestedView)) {
        const selected = document.getElementById('gallery-view-' + requestedView);
        if (selected instanceof HTMLInputElement) selected.checked = true;
    }

    viewInputs.forEach(function (input) {
        input.addEventListener('change', function () {
            if (!(input instanceof HTMLInputElement) || !input.checked) return;
            const nextUrl = new URL(window.location.href);
            nextUrl.searchParams.set('view', input.value);
            window.history.replaceState(null, '', nextUrl);
        });
    });
});`,
                    }}
                />
            </head>
            <body data-renderer-version={version} class='antialiased'>
                <header
                    id='toolbar'
                    class='sticky top-0 z-20 backdrop-blur-lg shadow-sm'
                    style='background-color: var(--bg-header); box-shadow: 0 1px 3px 0 var(--shadow-color), 0 1px 2px 0 var(--shadow-color);'
                >
                    <div class='max-w-screen-2xl mx-auto px-4 sm:px-6 lg:px-8'>
                        <div class='flex items-center justify-between h-16'>
                            <div class='gallery-view-controls' aria-label='Gallery view'>
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

                            <div class='flex items-center gap-4 text-sm flex-1 min-w-0 justify-end'>
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
                                        class='h-full px-4 rounded-md bg-indigo-600 text-white font-medium hover:bg-indigo-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-indigo-500'
                                    >
                                        Search
                                    </button>
                                </form>
                                <div class='relative inline-block'>
                                    <details class='relative' name='header'>
                                        <summary
                                            id='settings-button'
                                            class='p-2 rounded focus:outline-none focus:ring-2 focus:ring-indigo-500 cursor-pointer list-none hover-surface'
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
                                                class='p-4 rounded-md space-y-3'
                                            >
                                                {hiddenTagInputs}
                                                <label class='block text-sm font-medium' for='page-size-input'>
                                                    Page size
                                                </label>
                                                <select
                                                    id='page-size-input'
                                                    name='limit'
                                                    class='block w-full border border-transparent rounded-lg py-2 px-3 input-field focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-indigo-500'
                                                >
                                                    <PageSizeOptions limit={search.limit} />
                                                </select>
                                                <label class='block text-sm font-medium' for='sort-input'>
                                                    Sort
                                                </label>
                                                <select
                                                    id='sort-input'
                                                    name='sort'
                                                    class='block w-full border border-transparent rounded-lg py-2 px-3 input-field focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-indigo-500'
                                                >
                                                    <SortOptions sort={search.sort} />
                                                </select>
                                                <button
                                                    type='submit'
                                                    class='w-full py-2 px-4 rounded-md bg-indigo-600 text-white font-medium hover:bg-indigo-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-indigo-500'
                                                >
                                                    Apply
                                                </button>
                                            </form>
                                        </div>
                                    </details>
                                </div>
                                <div class='relative inline-block'>
                                    <button
                                        id='dark-mode-toggle'
                                        class='p-2 rounded focus:outline-none focus:ring-2 focus:ring-indigo-500 cursor-pointer hover-surface'
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
                                        class='p-2 rounded focus:outline-none focus:ring-2 focus:ring-indigo-500 cursor-pointer hover-surface'
                                        data-hx-on--click="document.getElementById('gallery-main')?.classList.toggle('inspector-open')"
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
                                    <details class='relative' name='header'>
                                        <summary
                                            id='upload-button'
                                            aria-haspopup='true'
                                            class='p-2 rounded focus:outline-none focus:ring-2 focus:ring-indigo-500 cursor-pointer list-none hover-surface'
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
                                                hx-target='#upload-result'
                                                data-hx-on--dragover="event.preventDefault(); this.classList.add('opacity-75', 'outline-dashed', 'outline-2', 'outline-indigo-500')"
                                                data-hx-on--dragleave="event.preventDefault(); this.classList.remove('opacity-75', 'outline-dashed', 'outline-2', 'outline-indigo-500')"
                                                data-hx-on--drop="event.preventDefault(); this.classList.remove('opacity-75', 'outline-dashed', 'outline-2', 'outline-indigo-500'); if(event.dataTransfer.files.length > 0) document.getElementById('file-input').files = event.dataTransfer.files;"
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
                                                    class='w-full py-2 px-4 rounded-md bg-indigo-600 text-white font-medium hover:bg-indigo-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-indigo-500'
                                                >
                                                    Upload
                                                </button>
                                            </form>
                                            <div
                                                id='upload-result'
                                                class='p-4 pt-0'
                                                data-hx-on--before-swap='if (event.detail.xhr.status >= 400) { event.detail.shouldSwap = true; event.detail.isError = false; }'
                                            />
                                        </div>
                                    </details>
                                </div>
                            </div>
                        </div>
                    </div>
                </header>
                <main id='gallery-main' class='gallery-main main-scroll'>
                    <div class='gallery-content'>
                        <div id='filter-bar'>
                            <FilterBar f={search} />
                        </div>
                        <div id='gallery-layout' class='layout'>
                            <section class='main-content'>
                                <div id='photo-grid' class='masonry-grid'>
                                    <div
                                        hx-get='/fragment/items'
                                        hx-trigger='load'
                                        hx-target='#photo-grid'
                                        hx-swap='outerHTML'
                                        hx-include='#filter-bar,#preferences,#pagination-controls'
                                        class='gallery-status gallery-loading'
                                    >
                                        Loading initial content...
                                    </div>
                                </div>
                            </section>
                        </div>
                    </div>
                    <InspectorShell />
                </main>
            </body>
        </html>
    );
}

/**
 * Renders the main gallery HTML page.
 *
 * @param title - The page title.
 * @param version - The renderer/template version.
 * @param search - The current filter state.
 * @returns HTML string
 */
export default function gallery(title: string, version: string, search: ItemsFilter): string {
    return `<!DOCTYPE html>\n${renderToString(<GalleryPage title={title} version={version} search={search} />)}`;
}
