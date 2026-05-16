import { serve } from 'https://deno.land/std@0.190.0/http/server.ts';
import { Index, Ingest } from './handlers.ts';
import { FetchImageFromLFS } from './lfs.ts';

async function handler(req: Request): Promise<Response> {
    const url = new URL(req.url);
    console.log(
        `method=${req.method} path=${url.pathname} query=${url.search}`,
    );

    // Route: Fetch the actual image data from LFS
    if (url.pathname.startsWith('/image/')) {
        const oid = url.pathname.split('/')[2];
        return await FetchImageFromLFS(oid);
    }

    if (url.pathname === '/') {
        return await Index();
    }

    if (url.pathname === '/ingest' && req.method === 'POST') {
        return await Ingest(req);
    }

    return new Response('Not Found', { status: 404 });
}
console.log('Server running on http://localhost:8000');
await serve(handler, { port: 8000 });
