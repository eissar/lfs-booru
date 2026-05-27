import { dirname, join } from '@std/path';
import type { Event, ImageState, ImageStateIndex, TagIndex } from '@/indexer.ts';
import type { LibraryConnection } from './library.ts';
import { Mutex } from '@core/asyncutil/mutex';
import { isInt } from '@/util.ts';

type ItemSortField = 'id' | 'addedAt';
type ItemSortDirection = -1 | 1;
export type ItemSort = {
    field: ItemSortField;
    direction: ItemSortDirection;
};

export type ItemsFilter = {
    limit: number;
    tags?: string[];
    offset?: number;
    sort?: ItemSort;
};

// TODO:
// guard to detect file rotation (size < offset, or file switched)
// ensure: atomic operations
// only advance cursor (offset) after successfully applying entire events, incl. newline
//
// this should be stored in memory & written to disk
//
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

    /**
     * Create an empty derived index from which event replay can start.
     *
     * This should create/reset derived index artifacts, initialize the write-path
     * image ID sequence, remove any persisted replay cursor, and clear in-memory
     * cursor state.
     *
     * Call this only when `isInitialized()` returns `false`, before replaying
     * committed events.
     *
     * @returns Resolves after the empty index artifacts are written.
     */
    initializeEmptyIndex(): Promise<void>;

    getImage(id: string): Promise<ImageState | null>;

    getIdByOid(oid: string): Promise<string | null>;

    /** apply and write event_cursor */
    applyEvent(event: Event, nextCursor: IndexCursor): Promise<void>;

    /**
     * Reserve the next image ID for a new add event.
     *
     * Use this only on the write path before constructing a new `add` event.
     * Index replay must not allocate IDs; it should reconcile `next_image_id`
     * from committed add-event IDs so the event log remains authoritative.
     *
     * gaps in IDs are fine this is monotonically increasing.
     * deleting an image will not free up that ID until
     * we do compaction/ log minification.
     * only needs to be repeatable for combinations of
     * eventLog + IndexStore backend, not accross backends
     * since I don't want to deal with making it deterministic like that
     *
     * @returns The reserved image ID.
     */
    allocateImageId(): Promise<number>;

    listItems(options: ItemsFilter): AsyncIterable<[string, ImageState]>;

    listImagesByIds(ids: string[], options?: { limit?: number }): AsyncIterable<[string, ImageState]>;

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

export class JsonFileIndexStore implements DerivedIndexStore {
    // local mutex
    private readonly mu = new Mutex();
    private readonly nextIdMutex = new Mutex();

    conn: LibraryConnection;
    constructor(conn: LibraryConnection) {
        // replace by this.dir
        this.conn = conn;
    }

    cursorCache: IndexCursor | null = null;

    getCursor(): IndexCursor | null {
        // deno is single threaded so no mutex is
        // fine?
        if (this.cursorCache) return this.cursorCache;
        const cursorPath = join(this.conn.path, 'event_cursor');

        try {
            const c = JSON.parse(Deno.readTextFileSync(cursorPath)) as IndexCursor;
            this.cursorCache = c;
            return this.cursorCache;
        } catch (error) {
            // null is handled equivalently to a cursor at the beginning of the event log.
            if (error instanceof Deno.errors.NotFound) return null;
            throw error;
        }
    }

    async saveCursor(c: IndexCursor): Promise<void> {
        using _lock = await this.mu.acquire();
        const cursorPath = join(this.conn.path, 'event_cursor');
        await writeJsonFile(cursorPath, c);
        this.cursorCache = c;
    }

    async isInitialized(): Promise<boolean> {
        const nextImageIdIndex = join(this.conn.path, 'index', 'next_image_id');
        const paths = [
            join(this.conn.path, 'index', 'image_state.json'),
            join(this.conn.path, 'index', 'tag_index.json'),
            nextImageIdIndex,
        ];

        using _lock = await this.nextIdMutex.acquire();
        const valid = await Deno.readTextFile(nextImageIdIndex)
            .then((t) => {
                const id = Number(t.trim());
                if (isInt(id) && id >= 1) return true;
                return false;
            })
            .catch(() => {
                return false;
            });
        if (!valid) return valid;

        return await Promise.all(paths.map((p) => Deno.stat(p)))
            .then((stats) => stats.every((s) => s.isFile))
            .catch((error) => {
                if (error instanceof Deno.errors.NotFound) return false;
                throw error;
            });
    }

    // TODO:
    // make idempotent, rename to initializeIndex() ?
    // if (await this.isInitialized()) {
    //     throw new Error('already init');
    // }
    //
    async initializeEmptyIndex(): Promise<void> {
        using _lock = await this.mu.acquire();
        using _idLock = await this.nextIdMutex.acquire();

        // Ensure the library subdirectory structure exists.
        // we shouldn't need to do this since the template exists
        // but it's fine
        await Deno.mkdir(join(this.conn.path, 'images'), { recursive: true });
        await Deno.mkdir(join(this.conn.path, 'events'), { recursive: true });

        const indexDir = join(this.conn.path, 'index');
        await Deno.mkdir(indexDir, { recursive: true });

        await writeJsonFile(join(indexDir, 'image_state.json'), {});
        await writeJsonFile(join(indexDir, 'tag_index.json'), {});

        await Deno.writeTextFile(join(indexDir, 'next_image_id'), '1', {
            create: true,
        });

        await Deno.remove(join(this.conn.path, 'event_cursor')).catch((error) => {
            if (!(error instanceof Deno.errors.NotFound)) throw error;
        });

        this.cursorCache = null;
    }

    async getImage(id: string): Promise<ImageState | null> {
        using _lock = await this.mu.acquire();
        const statePath = join(this.conn.path, 'index', 'image_state.json');

        const imageState = await readJsonFile(statePath, () => ({} as ImageStateIndex));
        return imageState[id] ?? null;
    }

    async getIdByOid(oid: string): Promise<string | null> {
        using _lock = await this.mu.acquire();
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
        using _lock = await this.mu.acquire();

        const statePath = join(this.conn.path, 'index', 'image_state.json');
        const indexPath = join(this.conn.path, 'index', 'tag_index.json');
        const cursorPath = join(this.conn.path, 'event_cursor');

        const imageState = await readJsonFile(statePath, () => ({} as ImageStateIndex));
        const tagIndex = await readJsonFile(indexPath, () => ({} as TagIndex));
        applyEventToIndexState(imageState, tagIndex, event);

        if (event.op === 'add') {
            using _idLock = await this.nextIdMutex.acquire();

            const nextIdPath = join(this.conn.path, 'index', 'next_image_id');
            const text = await Deno.readTextFile(nextIdPath);
            const currentNextId = Number(text.trim());

            if (!isInt(currentNextId) || currentNextId < 1) {
                throw new Error(`Cannot apply add event ${event.id}: next image ID is "${text.trim()}"`);
            }

            const nextId = Math.max(currentNextId, event.id + 1);
            await Deno.writeTextFile(nextIdPath, String(nextId), { create: false });
        }

        // TODO: durability; If this fails after writing image_state.json but before writing tag_index.json,
        // then state and tag index are made inconsistent
        await writeJsonFile(statePath, imageState);
        await writeJsonFile(indexPath, tagIndex);

        // Write cursor last only after the derived indexes are durable.
        await writeJsonFile(cursorPath, nextCursor);
        this.cursorCache = nextCursor;
    }

    async *listItems(
        options: ItemsFilter,
    ): AsyncIterable<[string, ImageState]> {
        let entries: ImageStateIndex;

        {
            using _lock = await this.mu.acquire();
            const statePath = join(this.conn.path, 'index', 'image_state.json');
            entries = await readJsonFile(statePath, () => ({} as ImageStateIndex));
        }

        const limit = options.limit ?? Infinity;
        if (limit <= 0) return;

        const offset = options.offset ?? 0;
        let skipped = 0;
        let yielded = 0;

        const sort = options.sort ?? { field: 'id', direction: -1 };

        const sortedEntries = Object.entries(entries).sort(([aId, a], [bId, b]) => {
            if (sort.field === 'id') {
                return (Number(aId) - Number(bId)) * sort.direction;
            }

            if (sort.field === 'addedAt') {
                let compared = 0;

                if (a.addedAt < b.addedAt) {
                    compared = -1;
                } else if (a.addedAt > b.addedAt) {
                    compared = 1;
                }

                if (compared !== 0) return compared * sort.direction;

                return (Number(aId) - Number(bId)) * sort.direction;
            }

            return 0;
        });

        for (const [id, imageState] of sortedEntries) {
            if (options.tags && options.tags.length > 0) {
                const matches = options.tags.some((t) => imageState.tags.includes(t));
                if (!matches) continue;
            }

            if (skipped < offset) {
                skipped++;
                continue;
            }

            yield [id, imageState];

            yielded++;
            if (yielded >= limit) return;
        }
    }

    async *listImagesByIds(
        ids: string[],
        options: { limit?: number } = {},
    ): AsyncIterable<[string, ImageState]> {
        if (ids.length === 0) return;

        let entries: [string, ImageState][];

        {
            using _lock = await this.mu.acquire();
            const statePath = join(this.conn.path, 'index', 'image_state.json');
            const imageState = await readJsonFile(statePath, () => ({} as ImageStateIndex));
            entries = Object.entries(imageState);
        }
        const limit = options.limit ?? Infinity;
        if (limit <= 0) return;

        let yielded = 0;
        for (const [id, image] of entries) {
            if (!ids.includes(id)) continue;
            yield [id, image];

            yielded++;
            if (yielded >= limit) return;
        }
    }

    async stats(): Promise<{ images: number; tags: number }> {
        using _lock = await this.mu.acquire();

        const statePath = join(this.conn.path, 'index', 'image_state.json');
        const indexPath = join(this.conn.path, 'index', 'tag_index.json');

        const imageState = await readJsonFile(statePath, () => ({} as ImageStateIndex));
        const tagIndex = await readJsonFile(indexPath, () => ({} as TagIndex));

        return {
            images: Object.keys(imageState).length,
            tags: Object.keys(tagIndex).length,
        };
    }

    /**
     * Reserve the next image ID for a new add event.
     *
     * This advances `index/next_image_id` before returning the ID so concurrent
     * callers on this store instance cannot receive the same value. Callers are
     * expected to use the returned ID when constructing and committing the add
     * event. Index replay should reconcile the sequence from committed event IDs
     * instead of calling this method.
     *
     * @returns The reserved image ID.
     */
    async allocateImageId(): Promise<number> {
        using _lock = await this.nextIdMutex.acquire();

        const path = join(this.conn.path, 'index', 'next_image_id');
        const text = await Deno.readTextFile(path);
        const id = Number(text.trim());

        if (!isInt(id) || id < 1) {
            throw new Error(`Cannot allocate image ID: next image ID is "${text.trim()}"`);
        }

        await Deno.writeTextFile(path, String(id + 1), { create: false });
        return id;
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

// const eventsDir = 'events';

/**
 * Add an image ID to a tag's entry in the tag index, creating the entry if needed.
 *
 * @param tagIndex Mutable tag index to update.
 * @param tag Tag string.
 * @param id Image ID to associate with the tag.
 */
export function addToTag(tagIndex: TagIndex, tag: string, id: string): void {
    tagIndex[tag] ??= [];
    if (!tagIndex[tag].includes(id)) tagIndex[tag].push(id);
}
function removeFromTag(tagIndex: TagIndex, tag: string, id: string): void {
    if (!tagIndex[tag]) return;
    tagIndex[tag] = tagIndex[tag].filter((taggedId) => taggedId !== id);
    if (tagIndex[tag].length === 0) delete tagIndex[tag];
}

// private helper
function applyEventToIndexState(imageState: ImageStateIndex, tagIndex: TagIndex, event: Event): void {
    const id = String(event.id);

    switch (event.op) {
        case 'add': {
            const existing = imageState[id];
            if (existing) {
                for (const tag of existing.tags) removeFromTag(tagIndex, tag, id);
            }

            const img: ImageState = {
                oid: event.oid,
                path: event.path,
                tags: event.tags || [],
                width: event.width,
                height: event.height,
                name: event.name,
                mtime: event.mtime,
                addedAt: event.addedAt,
            };
            imageState[id] = img;
            for (const tag of img.tags) addToTag(tagIndex, tag, id);
            break;
        }
        case 'tag_add': {
            const img = imageState[id];
            if (!img) break;
            if (!img.tags.includes(event.tag)) img.tags.push(event.tag);
            addToTag(tagIndex, event.tag, id);
            break;
        }
        case 'tag_remove': {
            const img = imageState[id];
            if (!img) break;
            img.tags = img.tags.filter((tag) => tag !== event.tag);
            removeFromTag(tagIndex, event.tag, id);
            break;
        }
        case 'delete': {
            const img = imageState[id];
            if (img) {
                for (const tag of img.tags) removeFromTag(tagIndex, tag, id);
            }
            delete imageState[id];
            break;
        }
    }
}
