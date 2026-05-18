import { join } from '@std/path';
import type { DerivedIndexStore, IndexCursor } from '@/index_store.ts';
import { JsonFileIndexStore } from '@/index_store.ts';
import { LibraryConnection } from '@/library.ts';
import { TextLineStream } from '@std/streams';

export type ImageState = {
    oid: string;
    path: string;
    tags: string[];
    width: number;
    height: number;
    name: string;
    mtime: string;
};

type AddEvent = {
    op: 'add';
    id: number | string;
    oid: string;
    path: string;
    tags?: string[];
    width: number;
    height: number;
    name: string;
    mtime: string;
};

type TagAddEvent = {
    op: 'tag_add';
    id: number | string;
    tag: string;
};

type TagRemoveEvent = {
    op: 'tag_remove';
    id: number | string;
    tag: string;
};

type DeleteEvent = {
    op: 'delete';
    id: number | string;
};

export type Event = AddEvent | TagAddEvent | TagRemoveEvent | DeleteEvent;

export type TagIndex = Record<string, string[]>;
export type ImageStateIndex = Record<string, ImageState>;

export type IndexResult = {
    images: number;
    tags: number;
    eventFiles: number;
    events: number;
};

const eventsDir = 'events';
const indexDir = 'index';

function removeFromTag(tagIndex: TagIndex, tag: string, id: string): void {
    if (!tagIndex[tag]) return;
    tagIndex[tag] = tagIndex[tag].filter((taggedId) => taggedId !== id);
    if (tagIndex[tag].length === 0) delete tagIndex[tag];
}

export function addToTag(tagIndex: TagIndex, tag: string, id: string): void {
    tagIndex[tag] ??= [];
    if (!tagIndex[tag].includes(id)) tagIndex[tag].push(id);
}

export function applyEvent(imageState: ImageStateIndex, tagIndex: TagIndex, event: Event): void {
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

// we process events from the
// sharded events log at eventsDir
export async function processEvents(
    conn: LibraryConnection,
    store: DerivedIndexStore,
): Promise<IndexResult> {
    const eventShards: string[] = [];
    await Deno.mkdir(join(conn.path, indexDir), { recursive: true });

    // TODO: refac
    const entries = await Array.fromAsync(Deno.readDir(join(conn.path, eventsDir)))
        .catch((e) => {
            if (e instanceof Deno.errors.NotFound) return []; // Return empty array to skip loop
            throw e; // Bubble up unexpected errors
        });

    for (const s of entries) {
        if (s.isFile && s.name.endsWith('.ndjson')) {
            eventShards.push(s.name);
        }
    }

    eventShards.sort();

    const resumeCursor = store.getCursor();
    let eventCount = 0;
    let imageCount = 0;
    let tagCount = 0;
    const encoder = new TextEncoder();

    for (const shard of eventShards) {
        if (resumeCursor && shard < resumeCursor.eventFile) continue;

        const shardPath = join(conn.path, eventsDir, shard);
        // const file = await Deno.open(shardPath, { read: true });
        await using file = await Deno.open(shardPath, { read: true });

        const lineStream = file.readable
            .pipeThrough(new TextDecoderStream())
            .pipeThrough(new TextLineStream());

        let byteOffset = 0;

        if (resumeCursor && shard === resumeCursor.eventFile) {
            await file.seek(resumeCursor.byteOffset, Deno.SeekMode.Start);
            byteOffset = resumeCursor.byteOffset;
        }

        for await (const line of lineStream) {
            const lineBytes = encoder.encode(line).length + 1;
            const nextByteOffset = byteOffset + lineBytes;
            const cursor: IndexCursor = {
                eventFile: shard,
                byteOffset: nextByteOffset,
            };

            const event = JSON.parse(line) as Event;
            // apply and write event_cursor
            await store.applyEvent(event, cursor);
            eventCount++;

            byteOffset = nextByteOffset;
        }
    }

    // Read final counts from the store's files for reporting
    const statePath = join(conn.path, indexDir, 'image_state.json');
    const tagPath = join(conn.path, indexDir, 'tag_index.json');

    try {
        imageCount = Object.keys(JSON.parse(await Deno.readTextFile(statePath))).length;
    } catch {
        // store may not have written anything yet
    }
    try {
        tagCount = Object.keys(JSON.parse(await Deno.readTextFile(tagPath))).length;
    } catch {
        // store may not have written anything yet
    }

    const result: IndexResult = {
        images: imageCount,
        tags: tagCount,
        eventFiles: eventShards.length,
        events: eventCount,
    };

    console.log(
        `Indexed ${result.images} images, ${result.tags} tags from ${result.events} events in ${result.eventFiles} files`,
    );

    return result;
}

if (import.meta.main) {
    const conn: LibraryConnection = {
        path: Deno.args[0] ?? join(import.meta.dirname ?? Deno.cwd(), 'libraries/new'),
    };

    const store = new JsonFileIndexStore(conn);
    await processEvents(conn, store);
}
