import { escape } from '@std/html/entities';
import { join } from '@std/path';
import { h } from 'preact';
import { renderToString } from 'preact-render-to-string';
import { CachingHtmlRenderer, type GalleryImage } from '@/renderer.tsx';
import PhotoGrid from '@/template/PhotoGridFragment.tsx';
import { GalleryPage } from '@/template/GalleryPage.tsx';
import { ItemCard } from '@/template/ItemCard.tsx';

const args = Deno.args[0] === '--' ? Deno.args.slice(1) : Deno.args;
const outputDirectory = args[0] ?? '.lint-artifacts';

const sampleImages: GalleryImage[] = [
    {
        id: '1',
        oid: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
        path: 'images/example-landscape.png',
        tags: ['landscape', 'blue sky', 'rating:safe'],
        width: 1600,
        height: 1067,
        name: 'Example landscape.png',
        mtime: '2026-05-25T00:00:00.000Z',
        addedAt: '2026-05-25T00:00:00.000Z',
        contentType: 'image/png',
    },
    {
        id: '2',
        oid: 'fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210',
        path: 'images/example-portrait.png',
        tags: ['portrait', 'studio'],
        width: 900,
        height: 1200,
        name: 'Example portrait.png',
        mtime: '2026-05-25T00:00:00.000Z',
        addedAt: '2026-05-25T00:00:00.000Z',
        contentType: 'image/png',
    },
];

await Deno.remove(outputDirectory, { recursive: true }).catch((error) => {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
});
await Deno.mkdir(outputDirectory, { recursive: true });

const renderer = new CachingHtmlRenderer(outputDirectory, { version: 'lint-artifact' });
const cards = (await Promise.all(sampleImages.map((image) => renderer.renderImageCard(image)))).join('\n');
const populatedPhotoGrid = renderToString(
    h(PhotoGrid, {
        cards: sampleImages.map((image) => h(ItemCard, { image })),
        offset: String(sampleImages.length),
        hasMore: true,
    }),
);
const emptyPhotoGrid = renderToString(h(PhotoGrid, { cards: [], offset: '0', hasMore: false }));
const galleryPage = `<!DOCTYPE html>\n${
    renderToString(
        h(GalleryPage, {
            title: 'Lint gallery',
            version: 'lint-artifact',
            search: { limit: 25, offset: 0, tags: ['landscape', 'blue sky'] },
            params: { cards: [], offset: '0', hasMore: false },
        }),
    )
}`;
const populatedGalleryPage = replaceInitialPhotoGrid(galleryPage, populatedPhotoGrid);

const artifacts = new Map<string, string>([
    ['gallery.html', galleryPage],
    ['gallery.populated.html', populatedGalleryPage],
    ['image-card.fragment.html', cards],
    ['photo-grid.fragment.html', populatedPhotoGrid],
    ['photo-grid.empty.fragment.html', emptyPhotoGrid],
    ['photo-grid.page.html', wrapHtmlDocument('Photo grid lint artifact', populatedPhotoGrid)],
]);

const inlineStyleCss = extractInlineStyleCss(artifacts);
if (inlineStyleCss.length > 0) {
    artifacts.set('template-inline-styles.css', inlineStyleCss);
}

for (const [name, content] of artifacts) {
    await Deno.writeTextFile(join(outputDirectory, name), content);
}

console.log(`Wrote ${artifacts.size} lint artifacts to ${outputDirectory}`);

function replaceInitialPhotoGrid(page: string, photoGrid: string): string {
    const startMarker = '<div id="photo-grid" class="masonry-grid">';
    const start = page.indexOf(startMarker);
    if (start === -1) throw new Error('Cannot replace initial photo grid: start marker is missing');

    const sectionEnd = page.indexOf('</section>', start);
    if (sectionEnd === -1) throw new Error('Cannot replace initial photo grid: section end is missing');

    const end = page.lastIndexOf('</div>', sectionEnd);
    if (end === -1 || end < start) throw new Error('Cannot replace initial photo grid: grid end is missing');

    return `${page.slice(0, start)}${photoGrid.trim()}${page.slice(end + '</div>'.length)}`;
}

function wrapHtmlDocument(title: string, body: string): string {
    return `<!DOCTYPE html>
<html lang="en" data-theme="light">
    <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <title>${escape(title)}</title>
        <script src="https://cdn.tailwindcss.com"></script>
        <link rel="preconnect" href="https://fonts.googleapis.com">
        <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
        <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
        <link href="../static/gallery.css" rel="stylesheet">
    </head>
    <body data-renderer-version="lint-artifact">
        ${body}
    </body>
</html>
`;
}

function extractInlineStyleCss(artifacts: Map<string, string>): string {
    const rules: string[] = [];
    let styleIndex = 0;

    for (const [artifactName, content] of artifacts) {
        const styleAttributePattern = /\sstyle=(['"])([\s\S]*?)\1/g;
        for (const match of content.matchAll(styleAttributePattern)) {
            const declarations = normalizeDeclarations(decodeHtmlAttribute(match[2]));
            if (declarations.length === 0) continue;

            styleIndex++;
            rules.push([
                `/* Source: ${artifactName}, style attribute ${styleIndex} */`,
                `.template-inline-style-${styleIndex} {`,
                declarations,
                '}',
            ].join('\n'));
        }
    }

    return rules.join('\n\n');
}

function normalizeDeclarations(value: string): string {
    return value
        .split(';')
        .map((declaration) => declaration.trim())
        .filter((declaration) => declaration.length > 0)
        .map((declaration) => `    ${declaration};`)
        .join('\n');
}

function decodeHtmlAttribute(value: string): string {
    return value
        .replaceAll('&quot;', '"')
        .replaceAll('&#34;', '"')
        .replaceAll('&apos;', "'")
        .replaceAll('&#39;', "'")
        .replaceAll('&amp;', '&')
        .replaceAll('&lt;', '<')
        .replaceAll('&gt;', '>');
}
