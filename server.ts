import type { EventLog } from '@/event_log.ts';
import { NdjsonEventLog } from '@/event_log.ts';
import { handleIngest } from '@/handlers.ts';
import { DerivedIndexStore, JsonFileIndexStore } from '@/index_store.ts';
import { processEvents, ImageState } from '@/indexer.ts';
import { LfsConnection as LfsConn } from '@/lfs/api.ts';
import { serveDir } from '@std/http/file-server';

import { LibraryConnection as LibConn } from '@/library.ts';
import { debug } from '@/logging.ts';
import { CachingHtmlRenderer, GalleryImage, HtmlRenderer } from '@/renderer.ts';
import { c } from '@/util.ts';
import { join } from '@std/path';

const LFS_SERVER = 'http://localhost:8080';

const conn: LfsConn = {
    url: LFS_SERVER,
    auth: `Basic ${btoa('user:pass')}`,
    user: 'USER',
    repo: 'REPO',
};

function createHandler(
    store: DerivedIndexStore,
    eventLog: EventLog,
    conn: LfsConn,
    lib: LibConn,
    render: HtmlRenderer,
): (req: Request) => Promise<Response> {
    return async (req: Request): Promise<Response> => {
        const url = new URL(req.url);

        console.log(
            `[request] method=${req.method} path=${url.pathname} query=${url.search}`,
        );

        if (url.pathname.startsWith('/image/')) {
            const url = new URL(req.url);
            const oid = url.pathname.split('/')[2];
            return await GetObjectContent(conn, oid);
        }

        if (url.pathname === '/') {
            // 301?
            return Response.redirect(new URL('/gallery', url.origin), 302);
        }

        if (url.pathname === '/gallery') {
            const tags = url.searchParams.get('tags');
            const tagList = tags && tags.split(',') || [];

            const tagIndex = JSON.parse(Deno.readTextFileSync(join(lib.path, 'index', 'tag_index.json')));
            const ids = Object.keys(tagIndex)
                .filter((key) => tagList.includes(key))
                .flatMap((key) => tagIndex[key]) || [];

            let imageList: AsyncIterable<[string, ImageState]>;

            imageList = store.listImages();
            if (ids.length > 0) imageList = store.listImagesByIds(ids);

            const images: GalleryImage[] = [];
            for await (const [id, img] of imageList) {
                if (img.oid) images.push({ id, ...img });
            }
            const cards = await Promise.all(images.map((img) => render.renderImageCard(img)));

            return c.html(await render.renderGalleryPage({ title: 'Gallery', cards: cards }));
        }

        if (url.pathname === '/ingest' && req.method === 'POST') {
            return await handleIngest(req, store, eventLog, lib, conn);
        }

        if (url.pathname.startsWith('/static')) {
            return serveDir(req, {
                fsRoot: './static',
                urlRoot: 'static', // trim /static
            });
        }

        return new Response('Not Found', { status: 404 });
    };
}

// blocking
async function Start(port: number = 8000) {
    // todo: process flags

    const lib: LibConn = {
        path: '/home/eissar/code/lfs-booru/libraries/new/',
    };
    const store: DerivedIndexStore = new JsonFileIndexStore(lib);
    const eventLog: EventLog = new NdjsonEventLog(lib.path);
    const render: HtmlRenderer = new CachingHtmlRenderer(lib.path);

    const indexFlag = !(await store.isInitialized());

    // todo: end process flags

    debug(`library=${lib.path} LFS_SERVER=${LFS_SERVER}`);

    // TODO:
    // if (indexFlag) console.log('Attempting re-index from last checkpoint')

    if (indexFlag) console.log('Initializing index from scratch — this may take some time.');

    debug(`indexFlag=${indexFlag} IndexStoreBackend=${store.constructor.name}`);
    if (indexFlag) await processEvents(store, eventLog);
    // if (indexFlag) await processEvents(lib, store);

    Deno.serve({ port }, createHandler(store, eventLog, conn, lib, render));
}

if (import.meta.main) {
    Start();
}
