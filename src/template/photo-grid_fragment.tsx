import { renderToString } from 'preact-render-to-string';

function LoadMoreButton({ offset, hasMore }: { offset: string; hasMore: boolean }) {
    if (hasMore) {
        return (
            <div id="pagination-controls" class="px-1 pb-1">
                <input type="hidden" name="offset" value={offset} />
                <button
                    type="button"
                    hx-get="/fragment/items"
                    hx-target="#pagination-controls"
                    hx-swap="outerHTML"
                    hx-select="#photo-grid > *"
                    hx-include="#filter-bar,#preferences,#pagination-controls"
                    class="mt-6 w-full py-2 px-4 rounded-md bg-indigo-600 text-white font-medium hover:bg-indigo-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-indigo-500"
                >
                    Load more <span class="text-sm opacity-80">(showing {offset})</span>
                </button>
            </div>
        );
    }
    return (
        <div id="pagination-controls" class="px-1 pb-1">
            <input type="hidden" name="offset" value={offset} />
            <div role="status" class="gallery-status gallery-pagination-status">
                No more to show <span class="ml-1 text-sm opacity-80">(showing {offset})</span>
            </div>
        </div>
    );
}

/**
 * Renders the photo grid fragment.
 *
 * @param cards Pre-rendered image card HTML fragments.
 * @param nextOffset Next offset string for pagination display.
 * @param hasMore Whether more items are available.
 * @returns HTML string
 */
export default function photoGrid(cards: string, nextOffset: string, hasMore: boolean): string {
    return renderToString(
        <div id="photo-grid" class="masonry-grid">
            {/* deno-lint-ignore react-no-danger */}
            <span dangerouslySetInnerHTML={{ __html: cards }} />
            <LoadMoreButton offset={nextOffset} hasMore={hasMore} />
        </div>,
    );
}
