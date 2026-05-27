import { EventLog } from './event_log.ts';
import { stageAndCommit } from './git.ts';
import type { DerivedIndexStore } from './index_store.ts';
import type { AddEvent } from './indexer.ts';
import { ingest } from './ingest.ts';
import type { LfsConnection } from './lfs/api.ts';
import type { LibraryConnection } from './library.ts';
import { typeByExtension } from '@std/media-types';
import { Uint8ArrayReader, Uint8ArrayWriter, ZipReader } from 'zip-js';
import { panic } from './util.ts';
import { debug } from './logging.ts';

/**
 * Iterate `<id>.info/` directories under a root path, yielding
 * `[metadata, dataBytes]` for each entry.
 */
async function* walkInfoDirs(
    root: string,
): AsyncGenerator<[Record<string, unknown>, Uint8Array]> {
    for await (const de of Deno.readDir(root)) {
        if (!de.isDirectory || !de.name.endsWith('.info')) continue;

        const dir = `${root}/${de.name}`;
        let meta: Record<string, unknown>;
        try {
            meta = JSON.parse(await Deno.readTextFile(`${dir}/metadata.json`));
        } catch {
            continue;
        }

        let data: Uint8Array | null = null;
        for await (const fe of Deno.readDir(dir)) {
            if (fe.isFile && fe.name !== 'metadata.json') {
                debug(`processing dir ${dir}`)
                data = await Deno.readFile(`${dir}/${fe.name}`);
                break;
            }
        }
        if (data) yield [meta, data];
    }
}

/**
 * Open an Eagle `.eaglepack` archive and iterate its entries.
 *
 * The archive is extracted to a temporary directory under `/tmp` which is
 * cleaned up when the iterator returns or throws.
 *
 * @param packPath Path to the `.eaglepack` file.
 *
 * @example
 * ```ts ignore
 * import { openEaglePack } from "./eagle-import.ts";
 *
 * for await (const [meta, bytes] of openEaglePack("./Fonts.eaglepack")) {
 *   console.log(meta.name, bytes.byteLength);
 * }
 * ```
 */
export async function* openEaglePack(
    packPath: string | URL,
): AsyncGenerator<[Record<string, unknown>, Uint8Array]> {
    const tmpDir = await Deno.makeTempDir({ dir: '/tmp', prefix: 'eagle-import-' });
    try {
        const archive = await Deno.readFile(packPath).catch((cause: unknown) => {
            const msg = cause instanceof Error ? cause.message : String(cause);
            panic(`Cannot read archive at "${packPath}": ${msg}`);
        });

        const reader = new ZipReader(new Uint8ArrayReader(archive));
        for (const entry of await reader.getEntries()) {
            if (entry.directory) continue;
            const out = `${tmpDir}/${entry.filename}`;
            await Deno.mkdir(out.substring(0, out.lastIndexOf('/')), { recursive: true });
            await Deno.writeFile(out, await entry.getData(new Uint8ArrayWriter()));
        }
        await reader.close();

        yield* walkInfoDirs(tmpDir);
    } finally {
        await Deno.remove(tmpDir, { recursive: true }).catch(() => {});
    }
}

/**
 * Ingest every entry from an Eagle `.eaglepack` archive or `.library`
 * directory into the booru library.
 *
 * When `path` is a directory (e.g. `Memes.library/`) its `images/`
 * subdirectory is read directly.  Otherwise the path is treated as a
 * `.eaglepack` zip archive.
 *
 * Each entry is ingested via {@link ingest} with its name, tags, dimensions,
 * and modification time, then committed to the event log individually.
 *
 * @param lib Library connection descriptor.
 * @param conn LFS server connection.
 * @param store Derived index store.
 * @param eventLog Source event log for committing.
 * @param path Path to a `.eaglepack` file or a `.library` directory.
 * @returns Array of add events produced during import.
 *
 * @example
 * ```ts ignore
 * import { ingestFromEagleSource } from './eagle-import.ts';
 *
 * const events = await ingestFromEagleSource(lib, conn, store, log, './Memes.library');
 * console.log(`Imported ${events.length} items from library`);
 * ```
 *
 * @example
 * ```ts ignore
 * import { ingestFromEagleSource } from './eagle-import.ts';
 *
 * const events = await ingestFromEagleSource(lib, conn, store, log, './Packs/Art.eaglepack');
 * ```
 */
export async function ingestFromEagleSource(
    lib: LibraryConnection,
    conn: LfsConnection,
    store: DerivedIndexStore,
    eventLog: EventLog,
    path: string,
): Promise<AddEvent[]> {
    const info = await Deno.stat(path);
    const entries: AsyncGenerator<[Record<string, unknown>, Uint8Array]> = info.isDirectory
        ? walkInfoDirs(`${path}/images`)
        : openEaglePack(path);

    const events: AddEvent[] = [];

    for await (const [meta, bytes] of entries) {
        const ext = (meta.ext as string) || '';
        const mime = ext
            ? typeByExtension(`.${ext.toLowerCase()}`) || 'application/octet-stream'
            : 'application/octet-stream';
        const name = (meta.name as string) || `image.${ext}` || 'image';
        const file = new File([bytes as BlobPart], name, { type: mime });

        const tags = Array.isArray(meta.tags) ? (meta.tags as string[]).filter((t) => typeof t === 'string') : [];

        const width = typeof meta.width === 'number' ? meta.width : undefined;
        const height = typeof meta.height === 'number' ? meta.height : undefined;
        const mtime = typeof meta.modificationTime === 'string' ? meta.modificationTime : undefined;

        events.push(await ingest(lib, conn, store, file, tags, name, height, width, mtime));
    }

    if (events.length === 0) return events;

    const appendResult = await eventLog.appendManyWithRollback(events, async (appendResult) => {
        const paths = Array.from(
            new Set([
                appendResult.path,
                ...events.map((event) => event.path),
            ]),
        );
        await stageAndCommit(paths, `booru: import ${events.length} eagle items`, lib);
    });

    for (let i = 0; i < events.length; i++) {
        await store.applyEvent(events[i], appendResult.cursors[i]);
    }

    return events;
}

