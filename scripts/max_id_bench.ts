// deno-lint-ignore no-import-prefix
import { TextLineStream } from 'jsr:@std/streams@1.0.17/text-line-stream';
import { format } from 'jsr:@std/fmt/duration';

const FILE = './max_id.internal.json';
const TARGET_MB = 500;

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
/**
 * @example
 * ```typescript
 *
 * getMaxId(import.meta.resolve('./library/'))
 *
 * ```
 */
async function getMaxId(lib: string | URL): Promise<number> {
    using file = await Deno.open(lib);
    let maxId = -Infinity;

    const lines = file.readable
        .pipeThrough(new TextDecoderStream())
        .pipeThrough(new TextLineStream());

    for await (const line of lines) {
        if (line.trim() === '') continue;

        const value = JSON.parse(line);
        const id = Number(value.id);

        if (Number.isFinite(id) && id > maxId) {
            maxId = id;
        }
    }

    return maxId;
}

let needInit = false;

await Deno.stat(FILE).catch(() => needInit = true);

const time = performance.now();
if (needInit) generateFile(FILE, TARGET_MB);
if (needInit) console.log(`Init took: ${format(performance.now() - time)}`);

Deno.bench('max_id_benchmark', async () => {
    await getMaxId(FILE);
});
