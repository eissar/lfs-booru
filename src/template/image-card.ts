import { escape } from '@std/html/entities';
import { html } from '@/html.ts';
import { GalleryImage } from '@/renderer.ts';

/** fragment */
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

    return html`
        <div>
            <p><strong>${imageName}</strong></p>
            <div>Tags: ${tags}</div>
            <p>${image.width}×${image.height}</p>
            <img src="${imageSrc}" />
        </div>
    `;
}
