import type { DerivedIndexStore } from './index_store.ts';
import type { EventLog } from './event_log.ts';
import { GetObjectContent, LfsConnection as LfsConn } from './lfs/api.ts';
import { LibraryConnection } from './library.ts';
import { debug } from './logging.ts';
import { simpleGit } from 'simple-git';
import { ingestFile } from '@/ingest.ts';
import { c } from '@/util.ts';

// /** @description */
type ImageState = {
    oid: string;
    path: string;
    tags: string[];
    width: number;
    height: number;
    name: string;
    mtime: string;
};

// TODO: consider
//
// enum Op {
//     Add    = 'add',
//     Remove = 'remove',
//     Update = 'update',
// }

export type Event = {
    op: string;
    id: number;
    path: string;
    oid: string;
    tags: string[];
    width: number;
    height: number;
    name: string;
    mtime: string;
};

// Narrow Event to add operations — internalIngest only handles image ingestion
export type AddEvent = Event & { op: 'add' };

type GalleryImage = ImageState & { id: string };

export async function handleRoot(store: DerivedIndexStore): Promise<Response> {
    const images: GalleryImage[] = [];
    for await (const [id, img] of store.listImages()) {
        if (img.oid) {
            images.push({ id, ...img });
        }
    }

    const html = `
    <h1>LFS Image Gallery</h1>
    <div style="display: flex; gap: 20px; flex-wrap: wrap;">
      ${
        images.map((img) => `
        <div style="border: 1px solid #ccc; padding: 10px; max-width: 350px;">
          <p><strong>${img.name}</strong></p>
          <p>Tags: ${img.tags.join(', ') || 'none'}</p>
          <p>${img.width}×${img.height}</p>
          <img src="/image/${img.oid}" style="max-width: 300px;" />
        </div>
      `).join('')
    }
    </div>`;

    return new Response(html, {
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
    });
}

export async function internalIngest(
    lib: LibraryConnection,
    eventLog: EventLog,
    e: AddEvent,
): Promise<Response | void> {
    const git = simpleGit(lib.path);

    const ingestError = await eventLog.appendWithRollback(e, async (appendResult) => {
        await git.add([e.path, appendResult.path])
            .then((result) => debug(result))
            .catch((err: unknown) => {
                throw new Response(
                    JSON.stringify({
                        error: `git add failed: ${err instanceof Error ? err.message : String(err)}`,
                    }),
                    { status: 500, headers: { 'Content-Type': 'application/json' } },
                );
            });

        await git.commit(
            `booru: add image ${e.id}`,
            [e.path, appendResult.path],
        )
            .then((result) => debug(result))
            .catch((err: unknown) => {
                throw new Response(
                    JSON.stringify({
                        error: `git commit failed: ${err instanceof Error ? err.message : String(err)}`,
                    }),
                    { status: 500, headers: { 'Content-Type': 'application/json' } },
                );
            });
    })
        .then(() => null)
        .catch((err: unknown) => {
            if (err instanceof Response) return err;
            return new Response(
                JSON.stringify({ error: `ingest failed: ${err instanceof Error ? err.message : String(err)}` }),
                { status: 500, headers: { 'Content-Type': 'application/json' } },
            );
        });
    if (ingestError) return ingestError;
}

export async function handleIngest(
    req: Request,
    store: DerivedIndexStore,
    eventLog: EventLog,
    lib: LibraryConnection,
    conn: LfsConn,
): Promise<Response> {
    const event: AddEvent | Response = await ingestFile(lib, conn, req, store)
        .catch((e) => {
            if (e.cause instanceof Response) {
                // upstream error
                // we can match url, path here if we want later.
                // if (new URL(e.cause.url).origin === conn.url)
                //
                // for now only upstream with cause:response is lfs-server
                // errors
                return c.error(e.message, 502);
            }
            return c.error(e.message, 400);
        });
    if (event instanceof Response) return event; // error

    const result = await internalIngest(lib, eventLog, event);
    if (result) return result;

    return new Response(JSON.stringify({ id: event.id }), {
        status: 201,
        headers: { 'Content-Type': 'application/json' },
    });
}

export async function handleImage(req: Request, conn: LfsConn): Promise<Response> {
    const url = new URL(req.url);
    const oid = url.pathname.split('/')[2];
    return await GetObjectContent(conn, oid);
}
