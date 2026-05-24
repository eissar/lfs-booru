import { html } from '@/html.ts';

/**
 * Renders the photo grid fragment.
 *
 * @param cards Pre-rendered image card HTML fragments.
 * @returns {string} HTML string
 */
export default function photoGrid(cards: string): string {
    return html`
        <div id="photo-grid" class="masonry-grid">
            ${cards}
        </div>
    `;
}
