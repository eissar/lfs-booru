import { dirname, join } from '@std/path';
import type { Event, ImageState, ImageStateIndex, TagIndex } from '../indexer.ts';
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

    getImage(id: string): Promise<ImageState | null>;
    getIdByOid(oid: string): Promise<string | null>;

    applyEvent(event: Event, nextCursor: IndexCursor): Promise<void>;

    listImages(options?: { limit?: number }): AsyncIterable<[string, ImageState]>;

    close(): Promise<void> | void;
}

const mu = new Mutex();

/** @param {LibraryConnection} conn - reference */
export async function JsonFileIndexStore(
    conn: LibraryConnection,
): Promise<DerivedIndexStore> {
    const cursorPath = join(conn.path, 'event_cursor');
    let cursorCache = await readJsonFile(cursorPath, () => null as IndexCursor | null);

    return {
        getCursor(): IndexCursor | null {
            // we do not need to use the mutex
            // using _lock = await mu.acquire();
            return cursorCache;
        },

        async getImage(id: string): Promise<ImageState | null> {
            using _lock = await mu.acquire();
            const statePath = join(conn.path, 'index', 'image_state.json');

            const imageState = await readJsonFile(statePath, () => ({} as ImageStateIndex));
            return imageState[id] ?? null;
        },

        async getIdByOid(oid: string): Promise<string | null> {
            using _lock = await mu.acquire();
            const statePath = join(conn.path, 'index', 'image_state.json');
            // const cursorPath = join(conn.path, 'event_cursor');

            const imageState = await readJsonFile(statePath, () => ({} as ImageStateIndex));

            for (const [id, image] of Object.entries(imageState)) {
                if (image.oid === oid) return id;
            }
            return null;
        },

        // → store applies event to imageState
        // → store writes imageState
        // → store writes nextCursor
        async applyEvent(event: Event, nextCursor: IndexCursor): Promise<void> {
            using _lock = await mu.acquire();

            const statePath = join(conn.path, 'index', 'image_state.json');
            const indexPath = join(conn.path, 'index', 'tag_index.json');
            const cursorPath = join(conn.path, 'event_cursor');

            const imageState = await readJsonFile(statePath, () => ({} as ImageStateIndex));
            applyEventToImageState(imageState, event);

            // TODO: durability; If this fails after writing image_state.json but before writing tag_index.json,
            // then state and tag index are made inconsistent
            await writeJsonFile(statePath, imageState);
            await writeJsonFile(indexPath, buildTagIndex(imageState));
            // write to cursor last
            await writeJsonFile(cursorPath, nextCursor);
            cursorCache = nextCursor;
        },

        async *listImages(options: { limit?: number } = {}): AsyncIterable<[string, ImageState]> {
            let entries: [string, ImageState][];

            {
                using _lock = await mu.acquire();
                const statePath = join(conn.path, 'index', 'image_state.json');
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
        },

        close(): void {
            // JsonFileIndexStore does not hold open resources.
        },
    };
}

function applyEventToImageState(imageState: ImageStateIndex, event: Event): void {
    const id = String(event.id);

    switch (event.op) {
        case 'add':
            imageState[id] = {
                oid: event.oid,
                path: event.path,
                tags: [...(event.tags ?? [])],
                width: event.width,
                height: event.height,
                name: event.name,
                mtime: event.mtime,
            };
            break;
        case 'tag_add': {
            const image = imageState[id];
            if (!image) break;
            if (!image.tags.includes(event.tag)) image.tags.push(event.tag);
            break;
        }
        case 'tag_remove': {
            const image = imageState[id];
            if (!image) break;
            image.tags = image.tags.filter((tag) => tag !== event.tag);
            break;
        }
        case 'delete':
            delete imageState[id];
            break;
    }
}

function buildTagIndex(imageState: ImageStateIndex): TagIndex {
    const tagIndex: TagIndex = {};

    for (const [id, image] of Object.entries(imageState)) {
        for (const tag of image.tags) {
            tagIndex[tag] ??= [];
            if (!tagIndex[tag].includes(id)) tagIndex[tag].push(id);
        }
    }

    return tagIndex;
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
