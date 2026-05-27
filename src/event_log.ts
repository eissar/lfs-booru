import { dirname, join } from '@std/path';
import { TextLineStream } from '@std/streams';
import type { Event } from '@/indexer.ts';
import type { IndexCursor } from '@/index_store.ts';
import { Mutex } from '@core/asyncutil/mutex';

const eventsDir = 'events';

/**
 * Result of appending an event to the source event log.
 */
export type EventAppendResult = {
    /** Relative repository path for the event log shard that was appended. */
    path: string;
    /** Byte offset before the append began. */
    previousOffset: number;
    /** Cursor immediately after the appended event. */
    cursor: IndexCursor;
};

/**
 * Result of appending a prepared NDJSON event file to the source event log.
 */
export type PreparedEventBatchAppendResult = EventAppendResult & {
    /** Prepared NDJSON file that was copied into the event log. */
    sourcePath: string;
    /** Number of bytes copied from the prepared NDJSON file. */
    appendedBytes: number;
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

    /**
     * Append an event for the duration of a protected operation.
     *
     * If the callback resolves, the append is kept. If the callback rejects,
     * the appended shard is truncated back to its previous offset before the
     * error is rethrown.
     *
     * @param event Event to append.
     * @param fn Operation that must succeed for the append to be kept.
     * @returns Resolves after the callback succeeds and the append is kept.
     */
    appendWithRollback(
        event: Event,
        fn: (appendResult: EventAppendResult) => Promise<void>,
    ): Promise<EventAppendResult>;

    /**
     * Append a prepared NDJSON event file for the duration of a protected operation.
     *
     * The prepared file must contain one serialized event per line and end with a
     * newline when non-empty. If the callback resolves, the append is kept. If the
     * callback rejects, the appended shard is truncated back to its previous offset
     * before the error is rethrown.
     *
     * @param sourcePath Prepared NDJSON event file to append.
     * @param fn Operation that must succeed for the append to be kept.
     * @returns Batch append result containing the changed path and final cursor.
     */
    appendPreparedFileWithRollback(
        sourcePath: string,
        fn: (appendResult: PreparedEventBatchAppendResult) => Promise<void>,
    ): Promise<PreparedEventBatchAppendResult>;
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
 *
 * Only this class should write event log files under its library root. Other
 * writers can make cursors wrong and events appear out of order.
 */
export class NdjsonEventLog implements EventLog, EventLogReader {
    private readonly mu = new Mutex();
    readonly rootPath: string;
    // we shouldn't need this
    // readonly shardName: () => string;

    /**
     * Create an NDJSON event log rooted at a library path.
     *
     * @param libraryRootPath Library root path.
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
        using _lock = await this.mu.acquire();
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
            previousOffset: byteOffset,
            cursor: {
                eventFile,
                byteOffset: byteOffset + new TextEncoder().encode(line).byteLength,
            },
        };
    }

    /**
     * Append an event and roll it back if the protected operation fails.
     *
     * The event-log mutex is held until the callback resolves or rollback
     * completes, so no later append can be truncated accidentally.
     *
     * @param event Event to append.
     * @param fn Operation that must succeed for the append to be kept.
     * @returns Resolves after the callback succeeds and the append is kept.
     */
    async appendWithRollback(
        event: Event,
        fn: (appendResult: EventAppendResult) => Promise<void>,
    ): Promise<EventAppendResult> {
        using _lock = await this.mu.acquire();
        const eventFile = getCurrentEventShard();
        const path = join(eventsDir, eventFile);
        const absolutePath = join(this.rootPath, path);

        await Deno.mkdir(dirname(absolutePath), { recursive: true });

        const line = JSON.stringify(event) + '\n';
        const previousOffset = await Deno.stat(absolutePath)
            .then((stat) => stat.size)
            .catch((error) => {
                if (error instanceof Deno.errors.NotFound) return 0;
                throw error;
            });
        const byteOffset = previousOffset + new TextEncoder().encode(line).byteLength;

        await Deno.writeTextFile(absolutePath, line, { append: true, create: true });

        const appendResult: EventAppendResult = {
            path,
            previousOffset,
            cursor: {
                eventFile,
                byteOffset,
            },
        };

        try {
            await fn(appendResult);
        } catch (error) {
            const stat = await Deno.stat(absolutePath);

            if (stat.size !== appendResult.cursor.byteOffset) {
                throw new Error('Cannot roll back event append: event log has changed');
            }

            await Deno.truncate(absolutePath, appendResult.previousOffset);
            throw error;
        }

        return appendResult;
    }

    /**
     * Append a prepared NDJSON event file and roll it back if the protected operation fails.
     *
     * The event-log mutex is held until the callback resolves or rollback
     * completes, so no later append can be truncated accidentally.
     *
     * @param sourcePath Prepared NDJSON event file to append.
     * @param fn Operation that must succeed for the append to be kept.
     * @returns Batch append result containing the changed path and final cursor.
     */
    async appendPreparedFileWithRollback(
        sourcePath: string,
        fn: (appendResult: PreparedEventBatchAppendResult) => Promise<void>,
    ): Promise<PreparedEventBatchAppendResult> {
        using _lock = await this.mu.acquire();
        const eventFile = getCurrentEventShard();
        const path = join(eventsDir, eventFile);
        const absolutePath = join(this.rootPath, path);

        await Deno.mkdir(dirname(absolutePath), { recursive: true });

        const sourceStat = await Deno.stat(sourcePath);

        const previousOffset = await Deno.stat(absolutePath)
            .then((stat) => stat.size)
            .catch((error) => {
                if (error instanceof Deno.errors.NotFound) return 0;
                throw error;
            });
        const byteOffset = previousOffset + sourceStat.size;

        const copyError = await (async () => {
            await using source = await Deno.open(sourcePath, { read: true });
            await using destination = await Deno.open(absolutePath, { write: true, append: true, create: true });
            await source.readable.pipeTo(destination.writable);
        })().then(() => null)
            .catch((error) => error);

        if (copyError != null) {
            await Deno.truncate(absolutePath, previousOffset);
            throw copyError;
        }

        const stat = await Deno.stat(absolutePath);
        if (stat.size !== byteOffset) {
            await Deno.truncate(absolutePath, previousOffset);
            throw new Error('Cannot append prepared event file: event log size is unexpected');
        }

        const appendResult: PreparedEventBatchAppendResult = {
            path,
            previousOffset,
            cursor: {
                eventFile,
                byteOffset,
            },
            sourcePath,
            appendedBytes: sourceStat.size,
        };

        const callbackError = await fn(appendResult)
            .then(() => null)
            .catch((error) => error);

        if (callbackError != null) {
            const stat = await Deno.stat(absolutePath);

            if (stat.size !== appendResult.cursor.byteOffset) {
                throw new Error('Cannot roll back event append: event log has changed');
            }

            await Deno.truncate(absolutePath, appendResult.previousOffset);
            throw callbackError;
        }

        return appendResult;
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
