import type { DerivedIndexStore } from './index_store.ts';
import type { EventLog } from './event_log.ts';
import { GetObjectContent, LfsConnection as LfsConn, PutObjectContent, PutObjectMeta } from './lfs/api.ts';
import { LibraryConnection } from './library.ts';
import { debug } from './logging.ts';
import { join } from '@std/path';
import { simpleGit } from 'simple-git';
import { writePointerFile } from '@/pointer.ts';

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
    bytes: Uint8Array<ArrayBuffer>,
    lib: LibraryConnection,
    eventLog: EventLog,
    conn: LfsConn,
    e: AddEvent,
    size: number,
): Promise<Response | void> {
    const pointerPath = join(lib.path, e.path);

    const metaRes = await PutObjectMeta(conn, e.oid, size);
    debug({ lfsMetaOk: metaRes.ok, lfsMetaStatus: metaRes.status });
    if (!metaRes.ok) {
        return new Response(
            JSON.stringify({ error: `LFS metadata registration failed: ${metaRes.status}` }),
            { status: 502, headers: { 'Content-Type': 'application/json' } },
        );
    }

    const lfsRes = await PutObjectContent(conn, e.oid, new Blob([bytes]));
    debug({ lfsOk: lfsRes.ok, lfsStatus: lfsRes.status });
    if (!lfsRes.ok) {
        return new Response(
            JSON.stringify({ error: `LFS push failed: ${lfsRes.status}` }),
            { status: 502, headers: { 'Content-Type': 'application/json' } },
        );
    }

    await writePointerFile(e.oid, size, pointerPath)
        .catch(() => {
            return new Response(
                JSON.stringify({ error: `failed to write pointer at ${pointerPath}` }),
                { status: 502, headers: { 'Content-Type': 'application/json' } },
            );
        });

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
    const form = await req.formData();

    const file = form.get('image') as File | null;
    if (!file) {
        return new Response(
            JSON.stringify({ error: "missing 'image' file field" }),
            { status: 400, headers: { 'Content-Type': 'application/json' } },
        );
    }

    const bytes = new Uint8Array(await file.arrayBuffer());

    const hashBuffer = await crypto.subtle.digest('SHA-256', bytes);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    const oid = hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');

    // don't check for duplicates; we allow duplicates
    // storage is content addressible
    // we can async check for duplicates by image signature
    // later.

    const size = bytes.byteLength;

    // const ids = Object.keys(state).map(Number);
    // const nextId = Math.max(...ids, 0) + 1;

    const tagsRaw = (form.get('tags') as string) || '[]';

    const tags = await Promise.resolve(tagsRaw)
        .then((raw) => JSON.parse(raw))
        .then((parsed) => {
            if (!Array.isArray(parsed)) return null;
            if (!parsed.every((item) => typeof item === 'string')) return null;
            return parsed as string[];
        })
        .catch(() => null);

    if (!tags) {
        return new Response(
            JSON.stringify({ error: 'tags must be a JSON array of strings' }),
            { status: 400, headers: { 'Content-Type': 'application/json' } },
        );
    }

    // TODO: parse image with async job to set dimensions ?
    const height = parseInt((form.get('height') as string) || '0') || 0;
    const width = parseInt((form.get('width') as string) || '0') || 0;

    const mtime = (form.get('mtime') as string) || new Date().toISOString();

    const id = await store.allocateImageId();
    const name = (form.get('name') as string) || `Image ${id}`;

    const event: AddEvent = {
        op: 'add',
        id: id,
        path: `images/${id}.png`,
        oid,
        tags,
        width,
        height,
        name,
        mtime,
    };

    const result = await internalIngest(bytes, lib, eventLog, conn, event, size);
    if (result) return result;

    return new Response(JSON.stringify({ id: id }), {
        status: 201,
        headers: { 'Content-Type': 'application/json' },
    });
}

export async function handleImage(req: Request, conn: LfsConn): Promise<Response> {
    const url = new URL(req.url);
    const oid = url.pathname.split('/')[2];
    return await GetObjectContent(conn, oid);
}
