import { DerivedIndexStore } from '@/index_store.ts';
import { LfsConnection as LfsConn, PutObjectContent, PutObjectMeta } from '@/lfs/api.ts';
import { AddEvent } from './indexer.ts';
import { writePointerFile } from './pointer.ts';
import { LibraryConnection as LibConn } from './library.ts';
import { join } from '@std/path';

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
