import type { ComponentChildren, JSX } from 'preact';

function LoadMoreButton({ offset, hasMore }: { offset: string; hasMore: boolean }) {
    if (hasMore) {
        return (
            <div id='pagination-controls' class='px-1 pb-1'>
                <input type='hidden' name='offset' value={offset} />
                <button
                    type='button'
                    hx-get='/fragment/items'
                    hx-target='#pagination-controls'
                    hx-target-error='#toasts-log'
                    hx-swap='outerHTML'
                    hx-select='#photo-grid > *'
                    hx-include='#filter-bar,#preferences,#pagination-controls'
                    class='mt-6 w-full py-2 px-4 rounded-md bg-indigo-600 text-white font-medium hover:bg-indigo-700 focus-ring'
                >
                    Load more <span class='text-sm opacity-80'>(showing {offset})</span>
                </button>
            </div>
        );
    }
    return (
        <div id='pagination-controls' class='px-1 pb-1'>
            <input type='hidden' name='offset' value={offset} />
            <div role='status' class='gallery-status gallery-pagination-status'>
                No more to show <span class='ml-1 text-sm opacity-80'>(showing {offset})</span>
            </div>
        </div>
    );
}

/**
 * Renders the photo grid component.
 *
 * @param cards Image records to render as grid cards.
 * @param nextOffset Next offset string for pagination display.
 * @param hasMore Whether more items are available.
 */
export default function PhotoGrid({ cards, offset, hasMore }: {
    cards: ComponentChildren;
    offset: string;
    hasMore: boolean;
}): JSX.Element {
    return (
        <div id='photo-grid' className='masonry-grid'>
            {cards}
            <LoadMoreButton offset={offset} hasMore={hasMore} />
        </div>
    );
}
