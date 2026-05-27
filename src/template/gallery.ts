import { escape } from '@std/html/entities';
import { html } from '@/html.ts';
import { ItemsFilter } from '@/index_store.ts';
import { itemFilterToSearchParams } from '../../server.ts';

function renderHiddenInput(name: string, value: string): string {
    return html`
        <input type="hidden" name="${escape(name)}" value="${escape(value)}">
    `;
}

// TODO: should incl limit, offset as chips?
//
// if returns false we don't render this
function renderFilterChipDisplayText(k: string, v: string): string|false {
    if (k === "tags") {
        return escape(v)
    }
    if (k === "sort") { // e.g., sort: idDesc
        return escape(`${k}: ${v}`)
    }
    return false
}

function renderFilterBar(f: ItemsFilter): string[] {
    const params = itemFilterToSearchParams(f);

    const entries: [string, string][] = [...params];

    const chips: string[] = [];
    for (let i = 0; i < entries.length; i++) {
        const [exclKey, exclVal] = entries[i];

        const escapedDisplayText = renderFilterChipDisplayText(exclKey, exclVal)
        if (!escapedDisplayText) continue // non-renderable filter

        params.delete(exclKey, exclVal);

        // query with the excluded parameter
        const query = params.toString()

        const removeUrl = query ? `/gallery?${query}` : '/gallery';
        const fragmentUrl = query ? `/fragment/items?${query}` : '/fragment/items';

        chips.push(html`
            <span class="filter-chip text-xs font-medium px-2 py-1 rounded-full backdrop-blur-sm tag-badge">
                <input type="hidden" name="${escape(exclKey)}" value="${escape(exclVal)}">
                <a
                    href="${escape(removeUrl)}"
                    hx-get="${escape(fragmentUrl)}"
                    hx-target="#photo-grid"
                    hx-swap="outerHTML"
                    hx-push-url="${escape(removeUrl)}"
                    hx-on::after-request="if (event.detail.successful) event.currentTarget.closest('.filter-chip').remove()"
                >#${escapedDisplayText}×</a>
            </span>
        `);

        // does not preserve ordering
        params.append(exclKey, exclVal);
    }
    return chips;
}

/**
 * Renders the reserved-width inspector sidebar shell.
 *
 * The outer `<aside>` owns the animated width so it reserves layout space when
 * open. The inner panel keeps a stable width and flex-column child layout so
 * header/footer controls do not squeeze while the sidebar opens or closes.
 *
 * @returns Inspector sidebar shell HTML fragment.
 */
function renderInspectorShell(): string {
    return html`
        <aside id="inspector" class="inspector shrink-0 overflow-hidden transition-[width] duration-150 ease-in-out">
            <div class="inspector-inner flex h-full flex-col">
                <header class="inspector-header shrink-0">
                    <div class="min-w-0">
                        <h2 class="truncate text-sm font-semibold">Inspector</h2>
                        <p class="text-xs" style="color: var(--text-muted);">Image details</p>
                    </div>
                    <button
                        type="button"
                        class="inspector-close rounded px-2 py-1 text-sm font-medium hover-surface"
                        onclick="document.getElementById('gallery-main')?.classList.remove('inspector-open')"
                    >×</button>
                </header>
                <div id="inspector-content" class="inspector-body min-h-0 flex-1 overflow-y-auto">
                    <p class="text-sm" style="color: var(--text-muted);">Select an image to inspect it.</p>
                </div>
            </div>
        </aside>
    `;
}

/**
 * Renders the main gallery HTML page.
 *
 * @param title - The page title.
 * @param version - The renderer/template version.
 * @returns {string} HTML string
 */
export default function gallery(
    title: string,
    version: string,
    search: ItemsFilter,
): string {
    const escapedTitle = escape(title);
    const escapedVersion = escape(version);

    const hiddenTagInputs: string = search?.tags
        ?.map((tag) => renderHiddenInput('tags', tag))
        .join('\n') ?? '';

    // TODO: ItemsFilter.keyword
    const filterBar = renderFilterBar(search).join('\n');

    // migrate any selected value from preferences to filterbar?
    const pageSizeOptions = [...new Set([10, 25, 50, 100, search.limit])]
        .sort((a, b) => a - b)
        .map((limit) => {
            let selected = '';
            if (limit === search.limit) selected = ' selected';
            return html`<option value="${String(limit)}"${selected}>${String(limit)}</option>`;
        }).join('\n');

    return html`
        <!DOCTYPE html>
        <html lang="en">
            <head>
                <meta charset="utf-8">
                <meta name="viewport" content="width=device-width, initial-scale=1">
                <title>${escapedTitle}</title>
                <script src="https://unpkg.com/htmx.org@2.0.4/dist/htmx.min.js"></script>
                <script src="https://cdn.tailwindcss.com"></script>
                <link rel="preconnect" href="https://fonts.googleapis.com">
                <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
                <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
                <link href="/static/gallery.css" rel="stylesheet">
                <script>
                (function () {
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

                // Close popouts (details) when clicking outside
                document.addEventListener('click', function (event) {
                    const details = document.querySelectorAll('details');
                    details.forEach(detail => {
                        if (!detail.contains(event.target)) {
                            detail.open = false;
                        }
                    });
                });
                </script>
            </head>
            <body data-renderer-version="${escapedVersion}" class="antialiased">
                <header
                    id="toolbar"
                    class="sticky top-0 z-20 backdrop-blur-lg shadow-sm"
                    style="background-color: var(--bg-header); box-shadow: 0 1px 3px 0 var(--shadow-color), 0 1px 2px 0 var(--shadow-color);"
                >
                    <div class="max-w-screen-2xl mx-auto px-4 sm:px-6 lg:px-8">
                        <div class="flex items-center justify-between h-16">
                            <div class="flex items-center gap-4 text-sm flex-1 min-w-0 justify-end">
                                <form
                                    id="search-form"
                                    method="get"
                                    action="/gallery"
                                    class="flex items-center gap-2 w-full max-w-xs flex-shrink-0"
                                >
                                    <input
                                        id="search-input"
                                        type="search"
                                        name="q"
                                        placeholder="Search..."
                                        class="block w-full border border-transparent rounded-lg py-2 px-4 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-indigo-500 focus:border-transparent input-field focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-indigo-500 focus-visible:border-transparent"
                                        required
                                    >
                                    ${hiddenTagInputs}
                                    <button
                                        type="submit"
                                        class="py-2 px-4 rounded-md bg-indigo-600 text-white font-medium hover:bg-indigo-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-indigo-500"
                                    >
                                        Search
                                    </button>
                                </form>
                                <div class="relative inline-block">
                                    <details class="relative" name="header">
                                        <summary
                                            id="settings-button"
                                            class="p-2 rounded focus:outline-none focus:ring-2 focus:ring-indigo-500 cursor-pointer list-none hover-surface"
                                        >
                                            <img
                                                src="https://unpkg.com/heroicons@2.0.13/24/outline/cog.svg"
                                                class="h-5 w-5"
                                                style="filter: var(--icon-filter);"
                                                alt="Settings"
                                            />
                                        </summary>
                                        <div
                                            class="absolute right-0 mt-2 w-64 rounded shadow-lg z-10 dropdown-container"
                                            style="background-color: var(--bg-surface);"
                                        >
                                            <form
                                                id="preferences"
                                                method="get"
                                                action="/gallery"
                                                class="p-4 rounded-md space-y-3"
                                            >
                                                ${hiddenTagInputs}
                                                <label class="block text-sm font-medium" for="page-size-input">
                                                    Page size
                                                </label>
                                                <select
                                                    id="page-size-input"
                                                    name="limit"
                                                    class="block w-full border border-transparent rounded-lg py-2 px-3 input-field focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-indigo-500"
                                                >
                                                    ${pageSizeOptions}
                                                </select>
                                                <button
                                                    type="submit"
                                                    class="w-full py-2 px-4 rounded-md bg-indigo-600 text-white font-medium hover:bg-indigo-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-indigo-500"
                                                >
                                                    Apply
                                                </button>
                                            </form>
                                        </div>
                                    </details>
                                </div>
                                <div class="relative inline-block">
                                    <button
                                        id="dark-mode-toggle"
                                        class="p-2 rounded focus:outline-none focus:ring-2 focus:ring-indigo-500 cursor-pointer hover-surface"
                                    >
                                        <img
                                            class="h-5 w-5 sun-icon"
                                            src="https://unpkg.com/heroicons@2.0.18/24/outline/sun.svg"
                                            style="filter: var(--icon-filter);"
                                        >
                                        <img
                                            class="h-5 w-5 moon-icon"
                                            src="https://unpkg.com/heroicons@2.0.18/24/outline/moon.svg"
                                            style="filter: var(--icon-filter);"
                                        >
                                    </button>
                                </div>
                                <div class="relative inline-block">
                                    <button
                                        id="inspector-toggle"
                                        type="button"
                                        class="p-2 rounded focus:outline-none focus:ring-2 focus:ring-indigo-500 cursor-pointer hover-surface"
                                        onclick="document.getElementById('gallery-main')?.classList.toggle('inspector-open')"
                                    >
                                        <img
                                            src="https://unpkg.com/heroicons@2.0.18/24/outline/information-circle.svg"
                                            class="h-5 w-5"
                                            style="filter: var(--icon-filter);"
                                            alt="Inspector"
                                        >
                                    </button>
                                </div>
                            <div class="relative inline-block">
                                <details class="relative" name="header">
                                    <summary
                                        id="upload-button"
                                        aria-haspopup="true"
                                        class="p-2 rounded focus:outline-none focus:ring-2 focus:ring-indigo-500 cursor-pointer list-none hover-surface"
                                    >
                                        <img
                                            src="https://unpkg.com/heroicons@2.0.13/24/outline/arrow-up-tray.svg"
                                            class="h-5 w-5"
                                            style="filter: var(--icon-filter);"
                                            alt="Upload"
                                        />
                                    </summary>
                                    <div
                                        class="absolute right-0 mt-2 w-96 rounded shadow-lg z-10 overflow-auto dropdown-container max-h-80"
                                        style="-ms-overflow-style:none; scrollbar-width:none; background-color: var(--bg-surface);"
                                    >
                                        <form
                                            id="upload-form"
                                            hx-post="/ingest"
                                            hx-encoding="multipart/form-data"
                                            hx-target="#upload-result"
                                            hx-on:dragover="event.preventDefault(); this.classList.add('opacity-75',
                                                'outline-dashed', 'outline-2', 'outline-indigo-500')"
                                            hx-on:dragleave="event.preventDefault(); this.classList.remove('opacity-75',
                                                'outline-dashed', 'outline-2', 'outline-indigo-500')"
                                            hx-on:drop="event.preventDefault(); this.classList.remove('opacity-75',
                                                'outline-dashed', 'outline-2', 'outline-indigo-500');
                                                if(event.dataTransfer.files.length > 0) document.getElementById('file-input').files
                                                = event.dataTransfer.files;"
                                            class="p-4 rounded-md transition-all duration-200"
                                        >
                                            <input
                                                type="file"
                                                name="image"
                                                id="file-input"
                                                class="
                                                    block w-full text-sm text-gray-500
                                                    file:mr-4 file:py-2 file:px-4
                                                    file:rounded file:border-0
                                                    file:text-sm file:font-medium
                                                    file:bg-indigo-50 file:text-indigo-700
                                                    hover:file:bg-indigo-100 mb-4
                                                "
                                                required
                                            >
                                            <button
                                                type="submit"
                                                id="submit-button"
                                                class="w-full py-2 px-4 rounded-md bg-indigo-600 text-white font-medium hover:bg-indigo-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-indigo-500"
                                            >
                                                Upload
                                            </button>
                                        </form>
                                        <div id="upload-result" class="p-4 pt-0"></div>
                                    </div>
                                </details>
                            </div>
                        </div>
                    </div>
                </header>
                <main id="gallery-main" class="gallery-main main-scroll">
                    <div class="gallery-content">
                        <div id="filter-bar">
                            ${filterBar}
                        </div>
                        <div id="gallery-layout" class="layout">
                            <section class="main-content">
                                <div id="photo-grid" class="masonry-grid">
                                    <div
                                        hx-get="/fragment/items"
                                        hx-trigger="load"
                                        hx-target="#photo-grid"
                                        hx-swap="outerHTML"
                                        hx-include="#filter-bar,#preferences,#pagination-controls"
                                    >
                                        Loading initial content...
                                    </div>
                                </div>
                            </section>
                        </div>
                    </div>
                    ${renderInspectorShell()}
                </main>
            </body>
        </html>
    `;
}
