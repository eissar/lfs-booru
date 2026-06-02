import type { DerivedIndexStore } from './index_store.ts';
import { EventLog, NdjsonEventLog } from './event_log.ts';
import { panic } from './util.ts';

// TODO: consider
//
// enum Op {
//     Add    = 'add',
//     Remove = 'remove',
//     Update = 'update',
// }

// TODO: evaluate - should
// added be here or in it's
// own index file ?
export type ImageState = {
    oid: string;
    thumbnailOid?: string;
    path: string;
    tags: string[];
    width: number;
    height: number;
    name: string;
    mtime: string;
    addedAt: string;
    contentType: string;
    isDeleted?: true;
};

export type AddEvent = {
    op: 'add';
    id: number;
    oid: string;
    thumbnailOid?: string;
    path: string;
    tags?: string[];
    width: number;
    height: number;
    name: string;
    mtime: string;
    addedAt: string;
    contentType: string;
};

export type TagAddEvent = {
    op: 'tag_add';
    id: number;
    tag: string;
};

export type TagRemoveEvent = {
    op: 'tag_remove';
    id: number;
    tag: string;
};

export type DeleteEvent = {
    op: 'delete';
    id: number;
};

export type RegenThumbnailEvent = {
    op: 'regen_thumbnail';
    id: number;
    thumbnailOid: string;
    contentType?: string;
};

export type UpdateMetadataEvent = {
    op: 'update_metadata';
    id: number;
    patch: {
        name?: string;
    };
};

export type Event = AddEvent | TagAddEvent | TagRemoveEvent | DeleteEvent | RegenThumbnailEvent | UpdateMetadataEvent;

export type TagIndex = Record<string, string[]>;

export type ImageStateIndex = Record<string, ImageState>;

export type IndexResult = {
    images: number;
    tags: number;
    eventFiles: number;
    events: number;
};

/**
 * Replay unprocessed events from the event log into the derived index store.
 *
 * Reads events from the event log starting at the store's current cursor and
 * applies each event to the store, advancing the cursor.
 *
 * @param store Derived index store to apply events to.
 * @param eventLog Source event log to read events from.
 * @returns Aggregate counts of indexed images, tags, and processed events.
 */
export async function processEvents(
    store: DerivedIndexStore,
    eventLog: EventLog,
): Promise<IndexResult> {
    if (!(eventLog instanceof NdjsonEventLog)) panic('Alternate EventLog not yet supported');

    let eventFileCount = 0;
    let lastShard: string | undefined;

    let eventCount = 0;
    for await (const { event, cursor } of eventLog.readEvents(store.getCursor())) {
        if (cursor.eventFile !== lastShard) {
            eventFileCount++;
            lastShard = cursor.eventFile;
        }
        await store.applyEvent(event, cursor);
        eventCount++;
    }

    const { images: imageCount, tags: tagCount } = await store.stats();

    const result: IndexResult = {
        images: imageCount,
        tags: tagCount,
        eventFiles: eventFileCount,
        events: eventCount,
    };

    console.log(
        `Indexed ${result.images} images, ${result.tags} tags from ${result.events} events in ${result.eventFiles} files`,
    );

    return result;
}
