import { join } from '@std/path';
import { LibraryConnection } from '@/library.ts';

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

type Event = AddEvent | TagAddEvent | TagRemoveEvent | DeleteEvent;

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

function addToTag(tagIndex: TagIndex, tag: string, id: string): void {
    tagIndex[tag] ??= [];
    if (!tagIndex[tag].includes(id)) tagIndex[tag].push(id);
}

function applyEvent(imageState: ImageStateIndex, tagIndex: TagIndex, event: Event): void {
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

export async function processEvents(conn: LibraryConnection): Promise<IndexResult> {
    const imageState: ImageStateIndex = {};
    const tagIndex: TagIndex = {};
    let eventCount = 0;

    const eventEntries = [];
    await Deno.mkdir(join(conn.path, indexDir), { recursive: true });

    try {
        for await (const entry of Deno.readDir(join(conn.path, eventsDir))) {
            if (entry.isFile && entry.name.endsWith('.ndjson')) eventEntries.push(entry.name);
        }
    } catch (e) {
        if (!(e instanceof Deno.errors.NotFound)) throw e;
    }

    eventEntries.sort();
    for (const eventFile of eventEntries) {
        const content = await Deno.readTextFile(join(conn.path, eventsDir, eventFile));
        for (const line of content.trim().split('\n')) {
            if (!line) continue;
            applyEvent(imageState, tagIndex, JSON.parse(line) as Event);
            eventCount++;
        }
    }

    await Deno.writeTextFile(
        join(conn.path, indexDir, 'image_state.json'),
        JSON.stringify(imageState),
    );
    await Deno.writeTextFile(
        join(conn.path, indexDir, 'tag_index.json'),
        JSON.stringify(tagIndex),
    );

    const result = {
        images: Object.keys(imageState).length,
        tags: Object.keys(tagIndex).length,
        eventFiles: eventEntries.length,
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

    await processEvents(conn);
}
