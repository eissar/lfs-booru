import { html } from '@/html.ts';
import { escape } from '@std/html/entities';

function renderLoadMoreButton(offset: string, hasMore: boolean): string {
    const nextOffset = escape(offset);
    if (hasMore) {
        return html`
            <div id="pagination-controls">
                <input type="hidden" name="offset" value="${nextOffset}">
                <div>Showing ${nextOffset}</div>
                <button
                    type="button"
                    hx-get="/fragment/items"
                    hx-target="#pagination-controls"
                    hx-swap="outerHTML"
                    hx-select="#photo-grid > *"
                    hx-include="#filter-bar,#preferences,#pagination-controls"
                    class="mt-6 w-full py-2 px-4 rounded-md bg-indigo-600 text-white font-medium hover:bg-indigo-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-indigo-500"
                >
                    Load more
                </button>
            </div>
        `;
    }
    return html`
        <div id="pagination-controls">
            <input type="hidden" name="offset" value="${nextOffset}">
            <div>Showing ${nextOffset}</div>
            <input type="hidden" name="offset" value="${nextOffset}">
            No More to Show
        </div>
    `;
}

/**
 * Renders the photo grid fragment.
 *
 * @param cards Pre-rendered image card HTML fragments.
 * @returns {string} HTML string
 */
export default function photoGrid(
    cards: string,
    nextOffset: string,
    hasMore: boolean,
): string {
    const loadMore = renderLoadMoreButton(nextOffset, hasMore);

    return html`
        <div id="photo-grid" class="masonry-grid">
            ${cards} ${loadMore}
        </div>
    `;
}
