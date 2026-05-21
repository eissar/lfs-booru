import { stageAndCommit } from './git.ts';
import { ingestFile } from './ingest.ts';
import { c } from './util.ts';
import { GitConstructError, GitError, TaskConfigurationError } from 'simple-git';
import type { EventLog } from './event_log.ts';
import type { DerivedIndexStore } from './index_store.ts';
import { GetObjectContent, LfsConnection as LfsConn } from './lfs/api.ts';
import { LibraryConnection } from './library.ts';

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

    const appendResult = await eventLog.appendWithRollback(event, async (appendResult) => {
        // pass relative file paths
        await stageAndCommit([appendResult.path, event.path], `booru: add image ${event.id}`, lib)
            .catch((err) => {
                if (err instanceof TaskConfigurationError || err instanceof GitConstructError) {
                    // we passed invalid or malformed commands, inputs to stageAndCommit
                    throw err;
                }
                if (err instanceof GitError) { // also GitResponseError
                    // other errors during git commit
                    throw err;
                }
                throw err;
            });
    }).catch((err: unknown) => {
        if (err instanceof Response) return err; // when does this happen?
        return c.error(`ingest failed: ${err instanceof Error ? err.message : String(err)}`, 500);
    });

    // we can make this more specific
    if (appendResult instanceof Error) return c.error(`error during event writing.`, 500);
    if (appendResult instanceof Response) return appendResult; // when does this happen?

    // apply after everything happened without err
    const applyResult = await store.applyEvent(event, appendResult.cursor)
        .catch(() => {
            return c.error('ERROR: could not apply event');
        });
    if (applyResult instanceof Response) return applyResult;

    return c.text('ok', 201);
}

export async function handleImage(req: Request, conn: LfsConn): Promise<Response> {
    const url = new URL(req.url);
    const oid = url.pathname.split('/')[2];
    return await GetObjectContent(conn, oid);
}
