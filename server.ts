import type { EventLog } from '@/event_log.ts';
import { NdjsonEventLog } from '@/event_log.ts';
import { handleImage, handleIngest, handleRoot } from '@/handlers.ts';
import { DerivedIndexStore, JsonFileIndexStore } from '@/index_store.ts';
import { processEvents } from '@/indexer.ts';
import { Connection as BooruConn } from '@/lfs/api.ts';
import { serveDir } from '@std/http/file-server';

import { LibraryConnection as LibConn } from '@/library.ts';
import { debug } from '@/logging.ts';

const LFS_SERVER = 'http://localhost:8080';

const conn: BooruConn = {
    url: LFS_SERVER,
    auth: `Basic ${btoa('user:pass')}`,
    user: 'USER',
    repo: 'REPO',
};

function createHandler(
    store: DerivedIndexStore,
    eventLog: EventLog,
    conn: BooruConn,
    lib: LibConn,
): (req: Request) => Promise<Response> {
    return async (req: Request): Promise<Response> => {
        const url = new URL(req.url);

        console.log(
            `[request] method=${req.method} path=${url.pathname} query=${url.search}`,
        );

        if (url.pathname.startsWith('/image/')) {
            return await handleImage(req, conn);
        }

        if (url.pathname === '/') {
            return await handleRoot(store);
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

    const indexFlag = !(await store.isInitialized());

    // todo: end process flags

    debug(`library=${lib.path} LFS_SERVER=${LFS_SERVER}`);

    // TODO:
    // if (indexFlag) console.log('Attempting re-index from last checkpoint')

    if (indexFlag) console.log('Initializing index from scratch — this may take some time.');

    debug(`indexFlag=${indexFlag} IndexStoreBackend=${store.constructor.name}`);
    if (indexFlag) await processEvents(store, eventLog);
    // if (indexFlag) await processEvents(lib, store);

    Deno.serve({ port }, createHandler(store, eventLog, conn, lib));
}

if (import.meta.main) {
    Start();
}
