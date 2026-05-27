import { escape } from '@std/html/entities';
import { html } from '@/html.ts';
import type { ImageState } from '@/indexer.ts';

/**
 * Renders an inspector details fragment for one image.
 *
 * @param image Image state to inspect.
 * @returns Inspector details HTML fragment.
 */
export default function inspector(image: ImageState): string {
    const tags = image.tags.map((tag) => {
        const params = new URLSearchParams();
        params.append('tags', tag);
        const tagUrl = `/gallery?${params.toString()}`;

        return html`
            <span class="text-xs font-medium px-2 py-1 rounded-full backdrop-blur-sm tag-badge">
                <a href="${escape(tagUrl)}">${escape(tag)}</a>
            </span>
        `;
    }).join('\n');

    return html`
        <section class="space-y-4">
            <img
                src="/image/${escape(image.oid)}"
                alt="${escape(image.name)}"
                class="aspect-square w-full rounded-lg object-cover"
            >
            <div class="space-y-1">
                <h3 class="text-sm font-semibold break-words">${escape(image.name)}</h3>
                <p class="text-xs" style="color: var(--text-muted);">${escape(`${image.width} × ${image.height}`)}</p>
            </div>
            <dl class="space-y-3 text-sm">
                <div>
                    <dt class="font-medium">OID</dt>
                    <dd class="text-xs break-all" style="color: var(--text-muted);">${escape(image.oid)}</dd>
                </div>
                <div>
                    <dt class="font-medium">Path</dt>
                    <dd class="text-xs break-all" style="color: var(--text-muted);">${escape(image.path)}</dd>
                </div>
                <div>
                    <dt class="font-medium">Added</dt>
                    <dd class="text-xs" style="color: var(--text-muted);">${escape(image.addedAt)}</dd>
                </div>
                <div>
                    <dt class="font-medium">Modified</dt>
                    <dd class="text-xs" style="color: var(--text-muted);">${escape(image.mtime)}</dd>
                </div>
            </dl>
            <div>
                <h4 class="mb-2 text-sm font-medium">Tags</h4>
                <div class="flex flex-wrap gap-2">
                    ${tags || html`<span class="text-xs" style="color: var(--text-muted);">No tags</span>`}
                </div>
            </div>
        </section>
    `;
}
