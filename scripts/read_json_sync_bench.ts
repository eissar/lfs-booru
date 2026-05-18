const FILE = './big.internal.json';
const TARGET_MB = 500;

type Entry = {
    oid: string;
    path: string;
    tags: string[];
    width: number;
    height: number;
    name: string;
    mtime: string;
};

function randomHex(bytes: number): string {
    const arr = crypto.getRandomValues(new Uint8Array(bytes));
    return [...arr].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function generateFile(path: string, targetMB: number) {
    const encoder = new TextEncoder();

    const file = Deno.openSync(path, {
        write: true,
        create: true,
        truncate: true,
    });

    try {
        file.writeSync(encoder.encode('{'));

        let written = 1;
        let i = 1;

        while (written < targetMB * 1024 * 1024) {
            const entry: Entry = {
                oid: randomHex(32),
                path: `images/${i}.png`,
                tags: [],
                width: 0,
                height: 0,
                name: `${i}.png`,
                mtime: new Date().toISOString(),
            };

            const chunk = `${i === 1 ? '' : ','}"${i}":${JSON.stringify(entry)}`;

            const encoded = encoder.encode(chunk);

            file.writeSync(encoded);
            written += encoded.length;

            i++;
        }

        file.writeSync(encoder.encode('}'));
    } finally {
        file.close();
    }
}

let fileExists = true;

try {
    Deno.statSync(FILE);
} catch (err) {
    if (err instanceof Deno.errors.NotFound) {
        fileExists = false;
    } else {
        throw err;
    }
}

if (!fileExists) {
    generateFile(FILE, TARGET_MB);
}

const fileSizeBytes = Deno.statSync(FILE).size;
const fileSizeMB = fileSizeBytes / (1024 * 1024);

Deno.bench({
    name: 'read + parse JSON sync',
    group: 'sync_json',
    fn() {
        const text = Deno.readTextFileSync(FILE);
        JSON.parse(text);
    },
});

Deno.bench({
    name: 'read JSON sync (file only)',
    group: 'sync_json',
    fn() {
        Deno.readTextFileSync(FILE);
    },
});

Deno.bench({
    name: 'parse JSON sync (parse only)',
    group: 'sync_json',
    baseline: true,
    fn() {
        const text = Deno.readTextFileSync(FILE);
        JSON.parse(text);
    },
});

const readStart = performance.now();
const text = Deno.readTextFileSync(FILE);
const readEnd = performance.now();

const parseStart = performance.now();
const parsed = JSON.parse(text);
const parseEnd = performance.now();

const entries = Object.keys(parsed).length;

console.log(`file  : ${fileSizeMB.toFixed(2)} MiB (${fileSizeBytes} bytes)`);
console.log(`entries : ${entries}`);
console.log(`read  : ${(readEnd - readStart).toFixed(2)} ms`);
console.log(`parse : ${(parseEnd - parseStart).toFixed(2)} ms`);
