import { dirname, join } from '@std/path';
import type { Event, ImageState, ImageStateIndex, TagIndex } from '../indexer.ts';
import type { LibraryConnection } from './library.ts';

export type IndexCursor = {
    eventFile: string;
    line: number;
    byteOffset: number;
};

export interface DerivedIndexStore {
    getCursor(): Promise<IndexCursor | null>;

    getImage(id: string): Promise<ImageState | null>;
    getIdByOid(oid: string): Promise<string | null>;

    applyEvent(event: Event, nextCursor: IndexCursor): Promise<void>;

    listImages(options?: { limit?: number }): AsyncIterable<[string, ImageState]>;

    close(): Promise<void> | void;
}

export type JsonFileIndexStoreOptions = {
    indexDir?: string;
    imageStateFile?: string;
    tagIndexFile?: string;
    cursorFile?: string;
};

// TODO: remove class and do like this
/** @param {LibraryConnection} conn - reference */
function JsonFileIndexStore(
    conn: LibraryConnection,
): DerivedIndexStore {
    return {
        async getCursor() {
            return null;
            Atomics;
        },

        async getImage(id) {
            return null;
        },

        async getIdByOid(oid) {
            return null;
        },

        async applyEvent(event, nextCursor) {},

        async *listImages(options) {
            yield ['id1', {} as ImageState];
        },

        async close() {},
    };
}

export class JsonFileIndexStorev0 implements DerivedIndexStore {
    #imageStatePath: string;
    #tagIndexPath: string;
    #cursorPath: string;
    #pending: Promise<void> = Promise.resolve();

    constructor(conn: LibraryConnection | string, options: JsonFileIndexStoreOptions = {}) {
        const root = typeof conn === 'string' ? conn : conn.path;
        const indexDir = join(root, options.indexDir ?? 'index');

        this.#imageStatePath = join(indexDir, options.imageStateFile ?? 'image_state.json');
        this.#tagIndexPath = join(indexDir, options.tagIndexFile ?? 'tag_index.json');
        this.#cursorPath = join(indexDir, options.cursorFile ?? 'cursor.json');
    }

    async getCursor(): Promise<IndexCursor | null> {
        await this.#pending;
        return await readJsonFile(this.#cursorPath, () => null as IndexCursor | null);
    }

    async getImage(id: string): Promise<ImageState | null> {
        await this.#pending;
        const imageState = await this.#readImageState();
        return imageState[id] ?? null;
    }

    async getIdByOid(oid: string): Promise<string | null> {
        await this.#pending;
        const imageState = await this.#readImageState();

        for (const [id, image] of Object.entries(imageState)) {
            if (image.oid === oid) return id;
        }

        return null;
    }

    async applyEvent(event: Event, nextCursor: IndexCursor): Promise<void> {
        const applied = this.#pending.then(() => this.#applyEvent(event, nextCursor));
        this.#pending = applied.catch(() => {});
        return await applied;
    }

    async *listImages(options: { limit?: number } = {}): AsyncIterable<[string, ImageState]> {
        await this.#pending;
        const imageState = await this.#readImageState();
        const limit = options.limit ?? Infinity;
        let yielded = 0;

        if (limit <= 0) return;

        for (const entry of Object.entries(imageState)) {
            yield entry;
            yielded++;
            if (yielded >= limit) return;
        }
    }

    close(): void {
        // JsonFileIndexStore does not hold open resources.
    }

    async #applyEvent(event: Event, nextCursor: IndexCursor): Promise<void> {
        const imageState = await this.#readImageState();
        applyEventToImageState(imageState, event);

        await writeJsonFile(this.#imageStatePath, imageState);
        await writeJsonFile(this.#tagIndexPath, buildTagIndex(imageState));
        await writeJsonFile(this.#cursorPath, nextCursor);
    }

    async #readImageState(): Promise<ImageStateIndex> {
        return await readJsonFile(this.#imageStatePath, () => ({} as ImageStateIndex));
    }
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
