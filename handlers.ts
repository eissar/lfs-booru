import { LibraryConnection } from '@/library.ts';
import { GetObjectContent, PutObjectContent, PutObjectMeta } from '@/lfs/api.ts';
import { Connection as BooruConn } from '@/lfs/api.ts';
import { debug } from '@/logging.ts';
import { dirname, join } from '@std/path';
import { simpleGit } from 'simple-git';

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

type Event = {
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

export async function handleRoot(lib: LibraryConnection): Promise<Response> {
    const state = JSON.parse(
        await Deno.readTextFile(join(lib.path, 'index/image_state.json')),
    ) as Record<string, ImageState>;

    const images = Object.entries(state)
        .filter(([, img]) => img.oid)
        .map(([id, img]) => ({ id, ...img }));

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

const eventLogPath = 'events/2026-05.ndjson';

export async function internalIngest(
    bytes: Uint8Array<ArrayBuffer>,
    lib: LibraryConnection,
    conn: BooruConn,
    e: Event,
    size: number,
): Promise<Response | void> {
    const pointer = `version https://git-lfs.github.com/spec/v1\noid sha256:${e.oid}\nsize ${size}\n`;
    const pointerPath = join(lib.path, e.path);
    const eventPath = join(lib.path, eventLogPath);

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

    // pointerPath - yyyy-mm.ndjson
    await Deno.mkdir(dirname(pointerPath), { recursive: true });
    await Deno.mkdir(dirname(eventPath), { recursive: true });
    await Deno.writeTextFile(pointerPath, pointer);
    await Deno.writeTextFile(
        eventPath,
        JSON.stringify(e) + '\n',
        { append: true, create: true },
    );

    const git = simpleGit(lib.path);
    const gitAddError = await git.add([e.path, eventLogPath])
        .then((result) => {
            debug(result);
            return null;
        })
        .catch((err: unknown) =>
            new Response(
                JSON.stringify({
                    error: `git add failed: ${err instanceof Error ? err.message : String(err)}`,
                }),
                { status: 500, headers: { 'Content-Type': 'application/json' } },
            )
        );
    if (gitAddError) return gitAddError;

    const gitCommitError = await git.commit(
        `booru: add image ${e.id}`,
        [e.path, eventLogPath],
    )
        .then((result) => {
            debug(result);
            return null;
        })
        .catch((err: unknown) =>
            new Response(
                JSON.stringify({
                    error: `git commit failed: ${err instanceof Error ? err.message : String(err)}`,
                }),
                { status: 500, headers: { 'Content-Type': 'application/json' } },
            )
        );
    if (gitCommitError) return gitCommitError;
}

export async function handleIngest(req: Request, lib: LibraryConnection, conn: BooruConn): Promise<Response> {
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

    const state = await Deno.readTextFile(join(lib.path, 'index/image_state.json'))
        .then((text) => JSON.parse(text) as Record<string, ImageState>)
        .catch(() => ({} as Record<string, ImageState>));
    for (const [id, img] of Object.entries(state)) {
        if (img.oid === oid) {
            return new Response(JSON.stringify({ id: parseInt(id) }), {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
            });
        }
    }

    const size = bytes.byteLength;

    const ids = Object.keys(state).map(Number);
    const nextId = ids.length > 0 ? Math.max(...ids) + 1 : 1;

    const name = (form.get('name') as string) || `Image ${nextId}`;
    const tagsRaw = (form.get('tags') as string) || '[]';
    const tags = await Promise.resolve(tagsRaw)
        .then((raw) => JSON.parse(raw))
        .then((parsed) => Array.isArray(parsed) ? parsed as string[] : null)
        .catch(() => null);
    if (!tags) {
        return new Response(
            JSON.stringify({ error: 'tags must be a JSON array string' }),
            { status: 400, headers: { 'Content-Type': 'application/json' } },
        );
    }
    const height = parseInt((form.get('height') as string) || '0') || 0;
    const width = parseInt((form.get('width') as string) || '0') || 0;
    const mtime = (form.get('mtime') as string) || new Date().toISOString();

    const event: Event = {
        op: 'add',
        id: nextId,
        path: `images/${nextId}.png`,
        oid,
        tags,
        width,
        height,
        name,
        mtime,
    };

    const result = await internalIngest(bytes, lib, conn, event, size);
    if (result) return result;

    return new Response(JSON.stringify({ id: nextId }), {
        status: 201,
        headers: { 'Content-Type': 'application/json' },
    });
}

export async function handleImage(req: Request, conn: BooruConn): Promise<Response> {
    const url = new URL(req.url);
    const oid = url.pathname.split('/')[2];
    return await GetObjectContent(conn, oid);
}
