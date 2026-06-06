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

async function applyShardBatch(
    store: DerivedIndexStore,
    tempDir: string,
    shard: string,
    lines: string[],
    previousOffset: number,
): Promise<void> {
    const path = `${tempDir}/${shard}.ndjson`;
    {
        await using f = await Deno.open(path, { write: true, createNew: true });
        await f.write(new TextEncoder().encode(lines.join('')));
    }
    await store.applyEventsFromFile(path, shard, previousOffset);
}

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
    const startCursor = store.getCursor();
    const startEventFile = startCursor?.eventFile;
    const startingOffset = startCursor?.byteOffset ?? 0;
    let lastCursor: IndexCursor | undefined;
    let eventCount = 0;

    const tempDir = await Deno.makeTempDir({ prefix: 'process-events-' });
    const shards = new Map<string, string[]>();

    for await (const { event, cursor } of eventLog.readEvents(startCursor)) {
        let buf = shards.get(cursor.eventFile);
        if (!buf) {
            buf = [];
            shards.set(cursor.eventFile, buf);
        }
        buf.push(JSON.stringify(event) + '\n');
        lastCursor = cursor;
        eventCount++;
    }

    for (const [shard, lines] of shards) {
        const offset = shard === startEventFile ? startingOffset : 0;
        await applyShardBatch(store, tempDir, shard, lines, offset);
    }

    try { await Deno.remove(tempDir, { recursive: true }); } catch { /* ignore */ }

    const { images: imageCount, tags: tagCount } = await store.stats();

    const result: IndexResult = {
        images: imageCount,
        tags: tagCount,
        eventFiles: shards.size,
        events: eventCount,
    };

    console.log(
        `Indexed ${result.images} images, ${result.tags} tags from ${result.events} events in ${result.eventFiles} files`,
    );

    return result;
}
