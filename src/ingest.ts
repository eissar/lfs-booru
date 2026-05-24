import { DerivedIndexStore } from '@/index_store.ts';
import { LfsConnection as LfsConn, PutObjectContent, PutObjectMeta } from '@/lfs/api.ts';
import { AddEvent } from './indexer.ts';
import { writePointerFile } from './pointer.ts';
import { LibraryConnection as LibConn } from './library.ts';
import { join } from '@std/path';

/**
 * Ingest an image file into the library.
 *
 * Computes the SHA-256 OID, pushes the object to the LFS server, writes a
 * Git LFS pointer file, and returns the resulting add event. The caller is
 * responsible for appending the event to the event log and committing.
 *
 * @param lib Library connection descriptor.
 * @param conn LFS server connection.
 * @param store Derived index store (used to allocate the image ID).
 * @param file Image file to ingest.
 * @param tags Tags to associate with the image.
 * @param name Optional display name (defaults to `Image {id}`).
 * @param height Optional image height in pixels.
 * @param width Optional image width in pixels.
 * @param mtime Optional modification time as an ISO-8601 string.
 * @returns The constructed add event.
 */
export async function ingest(
    lib: LibConn,
    conn: LfsConn,
    store: DerivedIndexStore,
    file: File,
    tags: string[],
    name?: string,
    height?: number,
    width?: number,
    mtime?: string,
): Promise<AddEvent> {
    const bytes = new Uint8Array(await file.arrayBuffer());

    const hashBuffer = await crypto.subtle.digest('SHA-256', bytes);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    const oid = hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');

    // don't check for duplicates; we allow duplicates
    // storage is content addressible
    // we can async check for duplicates by image signature
    // later.

    const size = bytes.byteLength;

    // TODO: parse image with async job to set dimensions ?
    //
    // zero is falsy
    if (!height) height = 0;
    if (!width) width = 0;

    if (!mtime) mtime = new Date().toISOString();

    const id = await store.allocateImageId();
    if (!name) name = `Image ${id}`;

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

    // NOTE: make sure to set cause:res when making lfs-server requests
    await PutObjectMeta(conn, event.oid, size).then((res) => {
        if (!res.ok) {
            throw new Error('put object meta failed', {
                cause: res,
            });
        }
    });
    await PutObjectContent(conn, event.oid, new Blob([bytes])).then((res) => {
        if (!res.ok) {
            throw new Error('LFS Push failed', {
                cause: res,
            });
        }
    });

    const pointerPath = join(lib.path, event.path);

    await writePointerFile(event.oid, size, pointerPath)
        .catch(() => {
            throw new Error(`failed to write pointer at ${pointerPath}`);
        });

    return event;
}

/**
 * Parse a multipart form-data request and ingest the contained image.
 *
 * Expects form fields `image` (file), `tags` (JSON string array), and
 * optionally `name`.
 *
 * @param lib Library connection descriptor.
 * @param conn LFS server connection.
 * @param req Incoming HTTP request with multipart form data.
 * @param store Derived index store (used to allocate the image ID).
 * @returns The constructed add event.
 */
export async function ingestFile(
    lib: LibConn,
    conn: LfsConn,
    req: Request,
    store: DerivedIndexStore,
): Promise<AddEvent> {
    const form = await req.formData();

    const file = form.get('image') as File | null;
    if (!file) throw new Error('missing form field: image');

    const tagsRaw = (form.get('tags') as string) || '[]';

    const tags = await Promise.resolve(tagsRaw)
        .then((raw) => JSON.parse(raw))
        .then((parsed) => {
            if (!Array.isArray(parsed)) return null;
            if (!parsed.every((item) => typeof item === 'string')) return null;
            return parsed as string[];
        })
        .catch(() => null);

    if (!tags) throw new Error('tags must be a JSON array of strings');

    const name = form.get('name') as string;

    return ingest(lib, conn, store, file, tags, name);
}
