import { escape } from '@std/html/entities';
import { html } from '@/html.ts';
import type { GalleryImage } from '@/renderer.ts';

/**
 * Renders an image card fragment.
 *
 * @param image Image record to render.
 * @param tags Pre-rendered tag link fragments.
 * @returns The image card HTML fragment string.
 */
export default function imageCard(image: GalleryImage, tags: string): string {
    const imageSrc = `/image/${image.oid}`; // oid doesn't need escape
    const imageName = escape(image.name);

    return html`
        <!-- TODO: add data-tags -->
        <article class="masonry-item group" data-image-id="${escape(image.id)}">
            <div class="relative overflow-hidden flex flex-col rounded-lg hover-card">
                <div class="block p-4 w-full peer order-2">
                    <a href="${imageSrc}">
                        <span class="font-medium truncate">${imageName}</span>
                    </a>
                    <div class="flex flex-wrap gap-2 text-xs mt-2">
                        ${tags}
                    </div>
                </div>

                <!-- TODO: add alt -->
                <img
                    src="${imageSrc}"
                    loading="lazy"
                    width="${image.width}"
                    height="${image.height}"
                    class="transition-transform duration-300 peer-hover:scale-105 order-1"
                />
            </div>
        </article>
    `;
}
