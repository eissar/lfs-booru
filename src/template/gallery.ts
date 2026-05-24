import { escape } from '@std/html/entities';
import { html } from '@/html.ts';

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
): string {
    const escapedTitle = escape(title);
    const escapedVersion = escape(version);

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
                <!-- {{template "header" .}} -->
                <header
                    id="toolbar"
                    class="sticky top-0 z-20 backdrop-blur-lg shadow-sm"
                    style="background-color: var(--bg-header); box-shadow: 0 1px 3px 0 var(--shadow-color), 0 1px 2px 0 var(--shadow-color);"
                >
                    <div class="max-w-screen-2xl mx-auto px-4 sm:px-6 lg:px-8">
                        <div class="flex items-center justify-between h-16">
                            <div class="flex items-center gap-4 text-sm flex-1 min-w-0 justify-end">
                                <div class="relative w-full max-w-xs flex-shrink-0">
                                    <!-- Search Icon -->
                                    <div class="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                                        <svg
                                            width="16"
                                            height="16"
                                            style="color: var(--text-muted); filter: var(--icon-filter);"
                                            fill="none"
                                            stroke="currentColor"
                                            viewBox="0 0 24 24"
                                        >
                                            <path
                                                stroke-linecap="round"
                                                stroke-linejoin="round"
                                                stroke-width="2"
                                                d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
                                            >
                                            </path>
                                        </svg>
                                    </div>
                                    <input
                                        id="search-input"
                                        type="search"
                                        name="keyword"
                                        placeholder="keyword search"
                                        hx-get="/items"
                                        hx-trigger="keyup changed delay:500ms"
                                        hx-target="#photo-grid"
                                        hx-swap="outerHTML"
                                        hx-indicator=".htmx-indicator"
                                        class="block w-full border border-transparent rounded-lg py-2 pl-10 pr-4 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-indigo-500 focus:border-transparent input-field focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-indigo-500 focus-visible:border-transparent"
                                    />
                                </div>
                                <!-- dark-mode-toggle -->
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
                            </div>
                            <!-- upload-button -->
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
                                        <!-- "TODO: inline indicator hx-submit--> yellow/pending -> after-request if
                                        (event.detail.successful) -> green/success" -->
                                        <!-- "hx-on::after-request="if(event.detail.successful) { this.reset(); document.getElementById('photo-grid').innerHTML = 'Loading...'; htmx.ajax('GET', '/f/items', {target: '#photo-grid', swap: 'innerHTML'});" }" -->
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
                <main class="max-w-screen-2xl mx-auto p-5 sm:p-6 lg:p-8">
                    <!-- main -> hx-on:dragenter="document.querySelector('details[name=header]').open = true" -->

                    <div class="layout">
                        <section class="main-content">
                            <div id="photo-grid" class="masonry-grid">
                                <div hx-get="/fragment/items" hx-trigger="load" hx-target=".main-content" hx-swap="outerHTML">
                                    Loading initial content...
                                </div>
                            </div>
                        </section>
                    </div>
                </main>
            </body>
        </html>
    `;
}
