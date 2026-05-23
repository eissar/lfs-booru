import { format } from 'jsr:@std/fmt/duration';

const FILE = './max_id.internal.json';
const WASM_FILE = new URL('./max_id_worker_prefix.wasm', import.meta.url);
const TARGET_MB = 500;
const WORKERS = 6;
const OVERLAP_BYTES = 1024;

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
    path: string;
    start: number;
    end: number;
};

type Result = {
    maxId: number;
};

type Ready = {
    ready: true;
};

type WasmExports = {
    memory: WebAssembly.Memory;
    grow_to_fit(len: number): void;
    max_id(ptr: number, len: number): number;
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

async function compileWasm(): Promise<WebAssembly.Module> {
    return await WebAssembly.compile(await Deno.readFile(WASM_FILE));
}

async function createExports(module: WebAssembly.Module): Promise<WasmExports> {
    const instance = await WebAssembly.instantiate(module);
    return instance.exports as WasmExports;
}

function maxIdInRange(wasm: WasmExports, file: Deno.FsFile, start: number, end: number) {
    const len = end - start;
    file.seekSync(start, Deno.SeekMode.Start);

    wasm.grow_to_fit(len);

    const memory = new Uint8Array(wasm.memory.buffer, 0, len);
    let offset = 0;
    while (offset < len) {
        const bytesRead = file.readSync(memory.subarray(offset));
        if (bytesRead === null) break;
        offset += bytesRead;
    }

    return wasm.max_id(0, offset);
}

const isWorker = new URL(import.meta.url).searchParams.has('worker');

if (isWorker) {
    const workerSelf = self as unknown as {
        onmessage: (event: MessageEvent<Work>) => void;
        postMessage(message: Ready | Result): void;
    };
    const wasmModule = await compileWasm();
    const wasm = await createExports(wasmModule);
    let file: Deno.FsFile | undefined;

    workerSelf.postMessage({ ready: true });
    workerSelf.onmessage = async (event: MessageEvent<Work>) => {
        const work = event.data;
        file ??= Deno.openSync(work.path);
        workerSelf.postMessage(
            {
                maxId: maxIdInRange(wasm, file, work.start, work.end),
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

    await Promise.all(workers.map((worker) =>
        new Promise<void>((resolve) => {
            worker.onmessage = (event: MessageEvent<Ready>) => {
                if (event.data.ready) resolve();
            };
        })
    ));

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
                path,
                start,
                end,
            });
        }));

        return Math.max(...results);
    }

    Deno.bench('max_id_wasm_worker_prefix_benchmark', async () => {
        await getMaxId(FILE);
    });
}
