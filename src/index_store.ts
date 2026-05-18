import { dirname, join } from '@std/path';
import { applyEvent } from '@/indexer.ts';
import type { Event, ImageState, ImageStateIndex, TagIndex } from '@/indexer.ts';
import type { LibraryConnection } from './library.ts';
import { Mutex } from '@core/asyncutil/mutex';

// TODO:
// guard to detect file rotation (size < offset, or file switched)
// ensure: atomic operations
// only advance cursor (offset) after successfully applying entire events, incl. newline
//
// this should be stored in memory & written to disk
//
/** @property {byteOffset} asdf */
export type IndexCursor = {
    eventFile: string;
    byteOffset: number;
};

export interface DerivedIndexStore {
    getCursor(): IndexCursor | null;
    saveCursor(c: IndexCursor): Promise<void>;

    /**
     * Return whether the derived index backend has all required artifacts.
     *
     * @returns `true` when the store can serve derived-index reads, otherwise `false`.
     *
     * @example Check startup readiness
     * ```ts ignore
     * import { assertEquals } from '@std/assert';
     *
     * const ready = await store.isInitialized();
     * assertEquals(ready, true);
     * ```
     */
    isInitialized(): Promise<boolean>;

    getImage(id: string): Promise<ImageState | null>;
    getIdByOid(oid: string): Promise<string | null>;

    /** apply and write event_cursor */
    applyEvent(event: Event, nextCursor: IndexCursor): Promise<void>;

    listImages(options?: { limit?: number }): AsyncIterable<[string, ImageState]>;

    /**
     * Return aggregate counts for derived index records.
     *
     * @returns Number of indexed images and distinct tags
     *
     * @example Read store statistics
     * ```ts ignore
     * import { assertEquals } from '@std/assert';
     *
     * const { images, tags } = await store.stats();
     * assertEquals(typeof images, 'number');
     * assertEquals(typeof tags, 'number');
     * ```
     */
    stats(): Promise<{ images: number; tags: number }>;

    close(): Promise<void> | void;
}

const mu = new Mutex();

export class JsonFileIndexStore implements DerivedIndexStore {
    conn: LibraryConnection;
    constructor(conn: LibraryConnection) {
        this.conn = conn;
    }

    cursorCache: IndexCursor | null = null;

    getCursor(): IndexCursor | null {
        // we do not need to use the mutex
        // using _lock = await mu.acquire();
        return this.cursorCache;
    }

    async saveCursor(c: IndexCursor): Promise<void> {
        using _lock = await mu.acquire();

        const cursorPath = join(this.conn.path, 'event_cursor');
        await writeJsonFile(cursorPath, c);
        this.cursorCache = c;
    }

    async isInitialized(): Promise<boolean> {
        const statePath = join(this.conn.path, 'index', 'image_state.json');
        const tagPath = join(this.conn.path, 'index', 'tag_index.json');

        return await Promise.all([Deno.stat(statePath), Deno.stat(tagPath)])
            .then(([stateStat, tagStat]) => stateStat.isFile && tagStat.isFile)
            .catch((error) => {
                if (error instanceof Deno.errors.NotFound) return false;
                throw error;
            });
    }

    async getImage(id: string): Promise<ImageState | null> {
        using _lock = await mu.acquire();
        const statePath = join(this.conn.path, 'index', 'image_state.json');

        const imageState = await readJsonFile(statePath, () => ({} as ImageStateIndex));
        return imageState[id] ?? null;
    }

    async getIdByOid(oid: string): Promise<string | null> {
        using _lock = await mu.acquire();
        const statePath = join(this.conn.path, 'index', 'image_state.json');
        // const cursorPath = join(this.conn.path, 'event_cursor');

        const imageState = await readJsonFile(statePath, () => ({} as ImageStateIndex));

        for (const [id, image] of Object.entries(imageState)) {
            if (image.oid === oid) return id;
        }
        return null;
    }

    // → store applies event to imageState
    // → store writes imageState
    // → store writes nextCursor
    async applyEvent(event: Event, nextCursor: IndexCursor): Promise<void> {
        using _lock = await mu.acquire();

        const statePath = join(this.conn.path, 'index', 'image_state.json');
        const indexPath = join(this.conn.path, 'index', 'tag_index.json');
        const cursorPath = join(this.conn.path, 'event_cursor');

        const imageState = await readJsonFile(statePath, () => ({} as ImageStateIndex));
        const tagIndex = await readJsonFile(indexPath, () => ({} as TagIndex));
        applyEvent(imageState, tagIndex, event);

        // TODO: durability; If this fails after writing image_state.json but before writing tag_index.json,
        // then state and tag index are made inconsistent
        await writeJsonFile(statePath, imageState);
        await writeJsonFile(indexPath, tagIndex);

        // TODO: this.saveCursor
        // write to cursor last
        await writeJsonFile(cursorPath, nextCursor);
        this.cursorCache = nextCursor;
    }

    async *listImages(options: { limit?: number } = {}): AsyncIterable<[string, ImageState]> {
        let entries: [string, ImageState][];

        {
            using _lock = await mu.acquire();
            const statePath = join(this.conn.path, 'index', 'image_state.json');
            const imageState = await readJsonFile(statePath, () => ({} as ImageStateIndex));
            entries = Object.entries(imageState);
        }

        const limit = options.limit ?? Infinity;
        if (limit <= 0) return;

        let yielded = 0;
        for (const entry of entries) {
            yield entry;
            yielded++;
            if (yielded >= limit) return;
        }
    }

    async stats(): Promise<{ images: number; tags: number }> {
        using _lock = await mu.acquire();

        const statePath = join(this.conn.path, 'index', 'image_state.json');
        const indexPath = join(this.conn.path, 'index', 'tag_index.json');

        const imageState = await readJsonFile(statePath, () => ({} as ImageStateIndex));
        const tagIndex = await readJsonFile(indexPath, () => ({} as TagIndex));

        return {
            images: Object.keys(imageState).length,
            tags: Object.keys(tagIndex).length,
        };
    }

    close(): void {
        // JsonFileIndexStore does not hold open resources.
    }
}

async function readJsonFile<T>(path: string, fallback: () => T): Promise<T> {
    try {
        return JSON.parse(await Deno.readTextFile(path)) as T;
    } catch (error) {
        if (error instanceof Deno.errors.NotFound) return fallback();
        throw error;
    }
}

async function writeJsonFile(path: string, value: unknown): Promise<void> {
    await Deno.mkdir(dirname(path), { recursive: true });

    const tmpPath = `${path}.${crypto.randomUUID()}.tmp`;
    await Deno.writeTextFile(tmpPath, JSON.stringify(value));
    await Deno.rename(tmpPath, path);
}
