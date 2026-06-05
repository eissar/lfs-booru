import type { DerivedIndexStore, IndexCursor } from './index_store.ts';
import type { EventLogReader } from './event_log.ts';

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
 * Batches all unprocessed events into a temporary NDJSON file and applies them
 * in one call to {@link DerivedIndexStore.applyEventsFromFile}, avoiding per-event
 * index file writes.
 *
 * @param store Derived index store to apply events to.
 * @param eventLog Source event log to read events from.
 * @returns Aggregate counts of indexed images, tags, and processed events.
 */
export async function processEvents(
    store: DerivedIndexStore,
    eventLog: EventLogReader,
): Promise<IndexResult> {
    let eventFileCount = 0;
    let lastShard: string | undefined;
    let eventCount = 0;

    const startCursor = store.getCursor();
    const startingOffset = startCursor?.byteOffset ?? 0;
    let lastCursor: IndexCursor | undefined;

    const tempFilePath = `${await Deno.makeTempDir({ prefix: 'process-events-' })}/events.ndjson`;

    {
        await using tempFile = await Deno.open(tempFilePath, { write: true, createNew: true });

        for await (const { event, cursor } of eventLog.readEvents(startCursor)) {
            if (cursor.eventFile !== lastShard) {
                eventFileCount++;
                lastShard = cursor.eventFile;
            }

            const line = JSON.stringify(event) + '\n';
            await tempFile.write(new TextEncoder().encode(line));
            lastCursor = cursor;
            eventCount++;
        }
    }

    // Apply all events in one batch.
    if (lastCursor) {
        await store.applyEventsFromFile(tempFilePath, lastCursor.eventFile, startingOffset);
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
