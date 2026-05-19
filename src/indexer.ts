import type { DerivedIndexStore } from './index_store.ts';
import { EventLog, NdjsonEventLog } from './event_log.ts';
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
    id: number;
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
    id: number;
    tag: string;
};

type TagRemoveEvent = {
    op: 'tag_remove';
    id: number;
    tag: string;
};

type DeleteEvent = {
    op: 'delete';
    id: number;
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
