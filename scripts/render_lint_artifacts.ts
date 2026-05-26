import { escape } from '@std/html/entities';
import { join } from '@std/path';
import type { GalleryImage } from '@/renderer.ts';
import { template } from '@/template/index.ts';

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
    },
];

await Deno.remove(outputDirectory, { recursive: true }).catch((error) => {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
});
await Deno.mkdir(outputDirectory, { recursive: true });

const cards = sampleImages.map((image) => template.fragment.ImageCard(image, renderTagLinks(image.tags))).join('\n');
const populatedPhotoGrid = template.fragment.photoGrid(cards, String(sampleImages.length), true);
const emptyPhotoGrid = template.fragment.photoGrid('', '0', false);
const galleryPage = template.page.Gallery('Lint gallery', 'lint-artifact', {
    limit: 25,
    offset: 0,
    tags: ['landscape', 'blue sky'],
});

const artifacts = new Map<string, string>([
    ['gallery.html', galleryPage],
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

function renderTagLinks(tags: string[]): string {
    return tags.map((tag) => {
        const search = new URLSearchParams();
        search.append('tags', tag);
        const tagUrl = `/gallery?${search.toString()}`;

        return `<a class="image-card-tags" href="${escape(tagUrl)}">${escape(tag)}</a>`;
    }).join('\n');
}

function wrapHtmlDocument(title: string, body: string): string {
    return `<!DOCTYPE html>
<html lang="en">
    <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <title>${escape(title)}</title>
        <link href="../static/gallery.css" rel="stylesheet">
    </head>
    <body>
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
