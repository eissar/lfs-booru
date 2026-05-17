// TODO: remove
// deno-lint-ignore-file no-unused-vars

// import { join } from '@std/path/join';
import { Index, Ingest } from './handlers.ts';
// import { panic } from '@/util.ts';
import { Connection as LfsConn, GetObjectContent } from '@/lfs/api.ts';

import { LibraryConnection } from '@/library.ts';

const LFS_SERVER = 'http://localhost:8080';

const conn: LfsConn = {
    url: LFS_SERVER,
    auth: `Basic ${btoa('user:pass')}`,
    user: 'USER',
    repo: 'REPO',
};

//: Library
const lib: LibraryConnection = {
    path: '/home/eissar/code/lfs-booru/libraries/new/',
};

async function handler(req: Request): Promise<Response> {
    const url = new URL(req.url);

    console.log(
        `method=${req.method} path=${url.pathname} query=${url.search}`,
    );

    // Route: Fetch the actual image data from LFS
    if (url.pathname.startsWith('/image/')) {
        const oid = url.pathname.split('/')[2];
        return await GetObjectContent(conn, oid);
    }

    if (url.pathname === '/') {
        // if starting up -> return string 'indexing'
        return Index(lib);
    }

    if (url.pathname === '/ingest' && req.method === 'POST') {
        return await Ingest(req, lib, conn);
    }

    return new Response('Not Found', { status: 404 });
}

if (import.meta.main) {
    Deno.serve({ port: 8000 }, handler);
}
