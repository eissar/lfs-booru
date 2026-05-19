import { join } from '@std/path';
import type { DerivedIndexStore, IndexCursor } from '@/index_store.ts';
import { JsonFileIndexStore } from '@/index_store.ts';
import { LibraryConnection } from '@/library.ts';
import { TextLineStream } from '@std/streams';
import { EventLog, EventLogReader, NdjsonEventLog } from './event_log.ts';
import { panic } from './util.ts';

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
    store: DerivedIndexStore,
    eventLog: EventLog,
): Promise<IndexResult> {
    const eventShards: string[] = [];

    if (!(eventLog instanceof NdjsonEventLog)) panic('Alternate EventLog not yet supported');

    let eventCount = 0;
    for await (const { event, cursor } of eventLog.readEvents(store.getCursor())) {
        await store.applyEvent(event, cursor);
        eventCount++;
    }

    const { images: imageCount, tags: tagCount } = await store.stats();

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
