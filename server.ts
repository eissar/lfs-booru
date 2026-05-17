import { handleImage, handleIngest, handleRoot } from '@/handlers.ts';
import { Connection as BooruConn } from '@/lfs/api.ts';

import { LibraryConnection as LibConn } from '@/library.ts';

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
        `method=${req.method} path=${url.pathname} query=${url.search}`,
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

if (import.meta.main) {
    Deno.serve({ port: 8000 }, handler);
}
