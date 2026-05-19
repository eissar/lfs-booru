import { dirname, join } from '@std/path';
import { TextLineStream } from '@std/streams';
import type { Event } from '@/indexer.ts';
import type { IndexCursor } from '@/index_store.ts';

const eventsDir = 'events';

/**
 * Result of appending an event to the source event log.
 */
export type EventAppendResult = {
    /** Relative repository path for the event log shard that was appended. */
    path: string;
    /** Cursor immediately after the appended event. */
    cursor: IndexCursor;
};

/**
 * Append-only source event log.
 */
export interface EventLog {
    /**
     * Append an event and return the resulting repository path and cursor.
     *
     * @param event Event to append.
     * @returns Append result containing the changed path and next cursor.
     */
    append(event: Event): Promise<EventAppendResult>;
}

// don't expose this in EventLog
// most consumers of that may do append only
// quirks of the filesystem approach mean we need
// to do this to avoid a leaky abstraction that
// exposes file reading conventions to the consumer
// of NdjsonEventlog
export interface EventLogReader {
    readEvents(cursor?: IndexCursor | null): AsyncIterable<{
        event: Event;
        cursor: IndexCursor;
    }>;
}

/**
 * Replay-capable source event log.
 */
export interface ReplayableEventLog extends EventLog {
    /**
     * Replay events after the provided cursor.
     *
     * @param cursor Cursor to resume from, or `null` to replay from the beginning.
     * @returns Async iterable of replayed events and their next cursors.
     */
    replayFrom(cursor: IndexCursor | null): AsyncIterable<{ event: Event; cursor: IndexCursor }>;
}

/**
 * File-backed NDJSON event log.
 */
export class NdjsonEventLog implements EventLog, EventLogReader {
    readonly rootPath: string;
    // we shouldn't need this
    // readonly shardName: () => string;

    /**
     * Create an NDJSON event log rooted at a library path.
     *
     * @param libraryRootPath Library root path.
     * @param shardName Function that returns the current event shard filename.
     * @returns File-backed event log instance.
     */
    constructor(libraryRootPath: string) {
        // constructor(libraryRootPath: string, shardName: () => string = getCurrentEventShard) {
        this.rootPath = libraryRootPath;
        // this.shardName = shardName;
    }

    /**
     * Append an event as a single NDJSON line.
     *
     * @param event Event to append.
     * @returns Append result containing the changed path and next cursor.
     */
    async append(event: Event): Promise<EventAppendResult> {
        const eventFile = getCurrentEventShard();
        const path = join(eventsDir, eventFile);
        const absolutePath = join(this.rootPath, path);

        await Deno.mkdir(dirname(absolutePath), { recursive: true });

        const line = JSON.stringify(event) + '\n';
        const byteOffset = await Deno.stat(absolutePath)
            .then((stat) => stat.size)
            .catch((error) => {
                if (error instanceof Deno.errors.NotFound) return 0;
                throw error;
            });

        await Deno.writeTextFile(absolutePath, line, { append: true, create: true });

        return {
            path,
            cursor: {
                eventFile,
                byteOffset: byteOffset + new TextEncoder().encode(line).byteLength,
            },
        };
    }

    /**
     * Read events from all NDJSON shards after the provided cursor.
     *
     * @param cursor Cursor to resume from, or `null` to read from the beginning.
     * @returns Async iterable of events and their next cursors.
     */
    async *readEvents(cursor?: IndexCursor | null): AsyncIterable<{
        event: Event;
        cursor: IndexCursor;
    }> {
        const eventShards: string[] = [];
        const entries = await Array.fromAsync(Deno.readDir(join(this.rootPath, eventsDir)))
            .catch((e) => {
                if (e instanceof Deno.errors.NotFound) return [];
                throw e;
            });

        for (const s of entries) {
            if (s.isFile && s.name.endsWith('.ndjson')) {
                eventShards.push(s.name);
            }
        }

        eventShards.sort();

        const resumeCursor = cursor ?? null;
        const encoder = new TextEncoder();

        for (const shard of eventShards) {
            if (resumeCursor && shard < resumeCursor.eventFile) continue;

            const shardPath = join(this.rootPath, eventsDir, shard);
            await using file = await Deno.open(shardPath, { read: true });

            let byteOffset = 0;

            if (resumeCursor && shard === resumeCursor.eventFile) {
                await file.seek(resumeCursor.byteOffset, Deno.SeekMode.Start);
                byteOffset = resumeCursor.byteOffset;
            }

            const lineStream = file.readable
                .pipeThrough(new TextDecoderStream())
                .pipeThrough(new TextLineStream());

            for await (const line of lineStream) {
                const lineBytes = encoder.encode(line).length + 1;
                const nextByteOffset = byteOffset + lineBytes;
                const cursor: IndexCursor = {
                    eventFile: shard,
                    byteOffset: nextByteOffset,
                };

                const event = JSON.parse(line) as Event;
                yield { event, cursor };

                byteOffset = nextByteOffset;
            }
        }
    }
}

/**
 * Return the current monthly event shard filename.
 *
 * @returns Event shard filename in `yyyy-mm.ndjson` form.
 */
function getCurrentEventShard(): string {
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    return `${year}-${month}.ndjson`;
}
