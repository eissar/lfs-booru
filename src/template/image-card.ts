import { escape } from '@std/html/entities';
import { html } from '@/html.ts';
import { GalleryImage } from '@/renderer.ts';

/** fragment */
export default function imageCard(image: GalleryImage, tags: string): string {
    const imageSrc = `/image/${image.oid}`; // oid doesn't need escape
    const imageName = escape(image.name);

    return html`
        <div>
            <p><strong>${imageName}</strong></p>
            <div>Tags: ${tags}</div>
            <p>${image.width}×${image.height}</p>
            <img src="${imageSrc}" />
        </div>
    `;
}
