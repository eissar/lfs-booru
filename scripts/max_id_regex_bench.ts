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

async function getMaxId(lib: string | URL): Promise<number> {
    using file = await Deno.open(lib);

    let maxId = -Infinity;
    const decoder = new TextDecoder();
    const idRegex = /"id"\s*:\s*(\d+)/g;

    let remainder = '';
    const buffer = new Uint8Array(64 * 1024);

    while (true) {
        const bytesRead = await file.read(buffer);
        if (bytesRead === null) break;

        const chunkText = remainder + decoder.decode(buffer.subarray(0, bytesRead));

        const lastNewlineIndex = chunkText.lastIndexOf('\n');

        let processText = chunkText;
        if (lastNewlineIndex !== -1) {
            processText = chunkText.substring(0, lastNewlineIndex);
            remainder = chunkText.substring(lastNewlineIndex);
        } else {
            remainder = '';
        }

        let match;
        while ((match = idRegex.exec(processText)) !== null) {
            const id = Number(match[1]);
            if (Number.isFinite(id) && id > maxId) {
                maxId = id;
            }
        }
    }

    return maxId;
}

let needInit = false;

await Deno.stat(FILE).catch(() => needInit = true);

const time = performance.now();
if (needInit) generateFile(FILE, TARGET_MB);
if (needInit) console.log(`Init took: ${format(performance.now() - time)}`);

Deno.bench('max_id_regex_benchmark', async () => {
    await getMaxId(FILE);
});
