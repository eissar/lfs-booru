import { escape } from '@std/html/entities';
import { html } from '@/html.ts';
import { GalleryImage } from '@/renderer.ts';

/** fragment */
export default function imageCard(image: GalleryImage, tags: string): string {
    const imageSrc = `/image/${image.oid}`; // oid doesn't need escape
    const imageName = escape(image.name);

    return html`
        <div style="border: 1px solid #ccc; padding: 10px; max-width: 350px;">
            <p><strong>${imageName}</strong></p>
            <div>Tags: ${tags}</div>
            <p>${image.width}×${image.height}</p>
            <img src="${imageSrc}" style="max-width: 300px;" />
        </div>
    `;
}
