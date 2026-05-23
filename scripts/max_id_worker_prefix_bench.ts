import { format } from 'jsr:@std/fmt/duration';

const FILE = './max_id.internal.json';
const TARGET_MB = 500;
const ID_OFFSET = new TextEncoder().encode('{"op":"add","id":').length;
const WORKERS = 4;
const OVERLAP_BYTES = 1024 * 1024;

type Entry = {
    op: string;
    id: number;
    path: string;
    oid: string;
    tags: string[];
    width: number;
    height: number;
    name: string;
    mtime: string;
};

type Work = {
    id: number;
    path: string;
    start: number;
    end: number;
    skipFirstLine: boolean;
};

type Result = {
    id: number;
    maxId: number;
};

function generateFile(path: string, targetMB: number) {
    const encoder = new TextEncoder();

    const file = Deno.openSync(path, {
        write: true,
        create: true,
        truncate: true,
    });

    try {
        let written = 0;
        let i = 1;

        while (written < targetMB * 1024 * 1024) {
            const entry: Entry = {
                op: 'add',
                id: i,
                path: `images/${i}.png`,
                oid: '0000000000000000000000000000000000000000000000000000000000000000',
                tags: [],
                width: 0,
                height: 0,
                name: `${i}.png`,
                mtime: new Date().toISOString(),
            };

            const line = JSON.stringify(entry) + '\n';
            const encoded = encoder.encode(line);

            file.writeSync(encoded);
            written += encoded.length;

            i++;
        }
    } finally {
        file.close();
    }
}

function maxIdInRange(path: string, start: number, end: number, skipFirstLine: boolean): number {
    using file = Deno.openSync(path);
    file.seekSync(start, Deno.SeekMode.Start);

    const buffer = new Uint8Array(1024 * 1024);
    let remaining = end - start;
    let carry = new Uint8Array(0);
    let maxId = -Infinity;
    let shouldSkipFirstLine = skipFirstLine;

    while (remaining > 0) {
        const bytesRead = file.readSync(buffer.subarray(0, Math.min(buffer.length, remaining)));
        if (bytesRead === null) break;
        remaining -= bytesRead;

        let bytes: Uint8Array;
        if (carry.length === 0) {
            bytes = buffer.subarray(0, bytesRead);
        } else {
            bytes = new Uint8Array(carry.length + bytesRead);
            bytes.set(carry);
            bytes.set(buffer.subarray(0, bytesRead), carry.length);
            carry = new Uint8Array(0);
        }

        let lineStart = 0;
        while (lineStart < bytes.length) {
            const newline = bytes.indexOf(0x0a, lineStart);
            if (newline === -1) {
                carry = bytes.slice(lineStart);
                break;
            }

            if (shouldSkipFirstLine) {
                shouldSkipFirstLine = false;
                lineStart = newline + 1;
                continue;
            }

            let cursor = lineStart + ID_OFFSET;
            let id = 0;

            while (bytes[cursor] >= 0x30 && bytes[cursor] <= 0x39) {
                id = id * 10 + bytes[cursor] - 0x30;
                cursor++;
            }

            if (id > maxId) maxId = id;
            lineStart = newline + 1;
        }
    }

    return maxId;
}

const isWorker = new URL(import.meta.url).searchParams.has('worker');

if (isWorker) {
    const workerSelf = self as unknown as {
        onmessage: (event: MessageEvent<Work>) => void;
        postMessage(message: Result): void;
    };

    workerSelf.onmessage = (event: MessageEvent<Work>) => {
        const work = event.data;
        workerSelf.postMessage(
            {
                id: work.id,
                maxId: maxIdInRange(work.path, work.start, work.end, work.skipFirstLine),
            } satisfies Result,
        );
    };
} else {
    let needInit = false;

    await Deno.stat(FILE).catch(() => needInit = true);

    const time = performance.now();
    if (needInit) generateFile(FILE, TARGET_MB);
    if (needInit) console.log(`Init took: ${format(performance.now() - time)}`);

    const size = (await Deno.stat(FILE)).size;
    const workers = Array.from({ length: WORKERS }, () =>
        new Worker(new URL(`${import.meta.url}?worker`), {
            type: 'module',
            deno: { permissions: 'inherit' },
        }));
    let workId = 0;

    function runWorker(worker: Worker, work: Work): Promise<number> {
        return new Promise((resolve) => {
            worker.onmessage = (event: MessageEvent<Result>) => resolve(event.data.maxId);
            worker.postMessage(work);
        });
    }

    async function getMaxId(path: string): Promise<number> {
        const shardSize = Math.ceil(size / workers.length);
        const results = await Promise.all(workers.map((worker, index) => {
            const start = index * shardSize;
            const end = Math.min(size, (index + 1) * shardSize + OVERLAP_BYTES);

            return runWorker(worker, {
                id: workId++,
                path,
                start,
                end,
                skipFirstLine: start !== 0,
            });
        }));

        return Math.max(...results);
    }

    Deno.bench('max_id_worker_prefix_benchmark', async () => {
        await getMaxId(FILE);
    });
}
