import { basename, join } from '@std/path';
import { Connection as LfsConn } from '@/lfs/api.ts';
import { panic } from '@/util.ts';
import { LibraryConnection } from '@/library.ts';
import { Init } from '@/git.ts';
import { GitConstructError } from 'simple-git';
import { internalIngest } from '@/handlers.ts';

for (const type of ['unhandledrejection', 'error']) {
    globalThis.addEventListener(type, (e) => {
        console.error('Exiting... Unhandled:', e);
        Deno.exit(1);
    });
}

if (!import.meta.dirname) panic('ran wrong');

const LFS_SERVER = 'http://localhost:8080';

const conn: LfsConn = {
    url: LFS_SERVER,
    auth: `Basic ${btoa('user:pass')}`,
    user: 'USER',
    repo: 'REPO',
};

const lib: LibraryConnection = {
    path: '/home/eissar/code/lfs-booru/libraries/new/',
};

type ImageTiming = {
    id: number;
    imagePath: string;
    bytes: number;
    readMs: number;
    hashMs: number;
    dimensionsMs: number;
    statMs: number;
    ingestMs: number;
    totalMs: number;
};

function ms(value: number): string {
    return `${value.toFixed(2)}ms`;
}

async function timed<T>(fn: () => Promise<T> | T): Promise<[T, number]> {
    const start = performance.now();
    const result = await fn();
    return [result, performance.now() - start];
}

function printTimings(rows: ImageTiming[], setup: Record<string, number>, totalMs: number): void {
    console.log('\nsetup timings');
    console.table(Object.fromEntries(Object.entries(setup).map(([key, value]) => [key, ms(value)])));

    console.log('\nper-image timings');
    console.table(rows.map((row) => ({
        id: row.id,
        image: row.imagePath,
        bytes: row.bytes,
        read: ms(row.readMs),
        hash: ms(row.hashMs),
        dimensions: ms(row.dimensionsMs),
        stat: ms(row.statMs),
        ingest: ms(row.ingestMs),
        total: ms(row.totalMs),
    })));

    const sum = (key: keyof ImageTiming) => rows.reduce((acc, row) => acc + Number(row[key]), 0);
    console.log('\naggregate timings');
    console.table({
        images: rows.length,
        bytes: rows.reduce((acc, row) => acc + row.bytes, 0),
        read: ms(sum('readMs')),
        hash: ms(sum('hashMs')),
        dimensions: ms(sum('dimensionsMs')),
        stat: ms(sum('statMs')),
        ingest: ms(sum('ingestMs')),
        imageTotal: ms(sum('totalMs')),
        scriptTotal: ms(totalMs),
    });
}

async function sha256Hex(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
    const hashBuffer = await crypto.subtle.digest('SHA-256', bytes);
    return Array.from(new Uint8Array(hashBuffer))
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('');
}

function pngDimensions(bytes: Uint8Array<ArrayBuffer>): { width: number; height: number } {
    const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
    const isPng = bytes.length >= 24 && signature.every((byte, index) => bytes[index] === byte);
    if (!isPng) return { width: 0, height: 0 };

    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    return {
        width: view.getUint32(16),
        height: view.getUint32(20),
    };
}

async function examplePngs(): Promise<string[]> {
    const home = Deno.env.get('HOME');
    if (!home) panic('HOME is not set');

    const dir = join(home, 'example-images');
    const paths: string[] = [];
    for await (const entry of Deno.readDir(dir)) {
        if (entry.isFile && entry.name.endsWith('png')) {
            paths.push(join(dir, entry.name));
        }
    }

    paths.sort();
    if (paths.length < 5) panic(`expected at least 5 png files in ${dir}, found ${paths.length}`);
    return paths.slice(0, 5);
}

if (import.meta.main) {
    const scriptStart = performance.now();
    const timings: ImageTiming[] = [];

    // We create from scratch every time. Run the LFS server on localhost:8080 first.
    const [, removeMs] = await timed(async () => {
        await Deno.remove(lib.path, { recursive: true })
            .catch((e) => {
                if (!(e instanceof Deno.errors.NotFound)) throw e;
            });
    });

    const [initError, initMs] = await timed(() =>
        Init(lib.path)
            .catch((e) => {
                if (e instanceof GitConstructError) panic('attention: invalid application state or git not on PATH');
                throw e;
            })
    );
    if (initError) panic(`failed to initialize library: ${initError.message}`);

    const [imagePaths, discoverImagesMs] = await timed(examplePngs);
    for (const [index, imagePath] of imagePaths.entries()) {
        const id = index + 1;
        const imageStart = performance.now();

        const [bytes, readMs] = await timed(() => Deno.readFile(imagePath));
        const [oid, hashMs] = await timed(() => sha256Hex(bytes));
        const [{ width, height }, dimensionsMs] = await timed(() => pngDimensions(bytes));
        const [stat, statMs] = await timed(() => Deno.stat(imagePath));

        const [result, ingestMs] = await timed(() =>
            internalIngest(bytes, lib, conn, {
                op: 'add',
                id,
                path: `images/${id}.png`,
                oid,
                tags: [],
                width,
                height,
                name: basename(imagePath),
                mtime: (stat.mtime ?? new Date()).toISOString(),
            }, bytes.byteLength)
        );

        if (result) {
            console.error(await result.text());
            Deno.exit(1);
        }

        const totalMs = performance.now() - imageStart;
        timings.push({
            id,
            imagePath,
            bytes: bytes.byteLength,
            readMs,
            hashMs,
            dimensionsMs,
            statMs,
            ingestMs,
            totalMs,
        });

        console.log(
            `ingested ${imagePath} as image ${id} (${oid}) ` +
                `[read=${ms(readMs)} hash=${ms(hashMs)} dimensions=${ms(dimensionsMs)} stat=${ms(statMs)} ` +
                `ingest=${ms(ingestMs)} total=${ms(totalMs)}]`,
        );
    }

    printTimings(timings, { removeMs, initMs, discoverImagesMs }, performance.now() - scriptStart);
}
