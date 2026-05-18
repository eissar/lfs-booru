import { handleImage, handleIngest, handleRoot } from '@/handlers.ts';
import { Connection as BooruConn } from '@/lfs/api.ts';
import { DerivedIndexStore, JsonFileIndexStore } from '@/index_store.ts';
import { processEvents } from './indexer.ts';

import { LibraryConnection as LibConn } from '@/library.ts';
import { debug } from '@/logging.ts';
import { join } from '@std/path/join';

const LFS_SERVER = 'http://localhost:8080';

const conn: BooruConn = {
    url: LFS_SERVER,
    auth: `Basic ${btoa('user:pass')}`,
    user: 'USER',
    repo: 'REPO',
};

const lib: LibConn = {
    path: '/home/eissar/code/lfs-booru/libraries/new/',
};

async function handler(req: Request): Promise<Response> {
    const url = new URL(req.url);

    console.log(
        `[request] method=${req.method} path=${url.pathname} query=${url.search}`,
    );

    // Route: Fetch the actual image data from LFS
    if (url.pathname.startsWith('/image/')) {
        return await handleImage(req, conn);
    }

    if (url.pathname === '/') {
        // if starting up -> return string 'indexing'
        return await handleRoot(lib);
    }

    if (url.pathname === '/ingest' && req.method === 'POST') {
        return await handleIngest(req, lib, conn);
    }

    return new Response('Not Found', { status: 404 });
}

// blocking
async function Start(port: number = 8000) {
    debug(`library=${lib.path}`);

    // process flags

    // TODO: check all derived artifacts not just image_state
    const indexFlag = await Deno.stat(join(lib.path, 'index', 'image_state.json'))
        .then((a) => {
            if (a.isFile) return false;
        })
        .then(() => true)
        .catch((e) => {
            if (!(e instanceof Deno.errors.NotFound)) debug(e);
            console.log('Missing indexed artifacts');
            return true;
        });
    // TODO:
    // if (indexFlag) console.log('Attempting re-index from last checkpoint')

    if (indexFlag) console.log('Initializing index from scratch — this may take some time.');

    const store: DerivedIndexStore = new JsonFileIndexStore(lib);

    debug(`indexFlag=${indexFlag} IndexStoreBackend=${store.constructor.name}`);
    if (indexFlag) await processEvents(lib, store);

    Deno.serve({ port }, handler);
}

if (import.meta.main) {
    Start();
}
