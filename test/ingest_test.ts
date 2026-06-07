const BASE_URL = Deno.env.get('BOORU_BASE_URL') ?? 'http://127.0.0.1:8000';

const MINIMAL_PNG = Uint8Array.from(
    atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg=='),
    (c) => c.charCodeAt(0),
);

const UNSUPPORTED_BYTES = new TextEncoder().encode('this is not a supported media file');

function testTag(name: string): string {
    return `delete-me-${name}-${crypto.randomUUID()}`;
}

async function deleteItemsByTag(tag: string): Promise<void> {
    const params = new URLSearchParams({ limit: '100', tags: tag });
    const res = await fetch(`${BASE_URL}/fragment/items?${params.toString()}`);

    if (res.status !== 200) {
        throw new Error(
            `Cleanup failed: expected 200 when listing tag "${tag}", got ${res.status}: ${await res.text()}`,
        );
    }

    const body = await res.text();
    const ids = [...body.matchAll(/data-image-id="(\d+)"/g)].map((match) => match[1]);

    for (const id of ids) {
        const form = new FormData();
        form.set('id', id);

        const deleteRes = await fetch(`${BASE_URL}/delete`, { method: 'POST', body: form });
        const deleteBody = await deleteRes.text();
        if (deleteRes.status !== 200) {
            throw new Error(
                `Cleanup failed: expected 200 when deleting item "${id}", got ${deleteRes.status}: ${deleteBody}`,
            );
        }
    }
}

function ingestForm(
    image: Uint8Array | null,
    opts?: { tags?: string; name?: string; filename?: string },
): FormData {
    const form = new FormData();
    if (image !== null) {
        form.set('image', new File([image.buffer as ArrayBuffer], opts?.filename ?? 'test.png', { type: 'image/png' }));
    }
    if (opts?.tags !== undefined) {
        form.set('tags', opts.tags);
    }
    if (opts?.name !== undefined) {
        form.set('name', opts.name);
    }
    return form;
}

Deno.test('POST /ingest returns 201 with valid image', async () => {
    const tag = testTag('valid-image');

    try {
        const form = ingestForm(MINIMAL_PNG, { tags: JSON.stringify([tag]) });
        const res = await fetch(`${BASE_URL}/ingest`, { method: 'POST', body: form });

        if (res.status !== 201) {
            throw new Error(`Expected 201, got ${res.status}: ${await res.text()}`);
        }

        await res.text();
    } finally {
        await deleteItemsByTag(tag);
    }
});

Deno.test('POST /ingest returns 201 with tags and name', async () => {
    const tag = testTag('tags-and-name');

    try {
        const form = ingestForm(MINIMAL_PNG, { tags: JSON.stringify(['test', tag]), name: 'my photo' });
        const res = await fetch(`${BASE_URL}/ingest`, { method: 'POST', body: form });

        if (res.status !== 201) {
            throw new Error(`Expected 201, got ${res.status}: ${await res.text()}`);
        }

        await res.text();
    } finally {
        await deleteItemsByTag(tag);
    }
});

Deno.test('POST /ingest returns 400 when image field is missing', async () => {
    const form = ingestForm(null);
    const res = await fetch(`${BASE_URL}/ingest`, { method: 'POST', body: form });

    if (res.status !== 400) {
        throw new Error(`Expected 400, got ${res.status}: ${await res.text()}`);
    }

    const body = await res.text();
    if (!body.includes('Missing form field: image')) {
        throw new Error(`Expected error about missing image field, got "${body}"`);
    }
});

Deno.test('POST /ingest returns 400 for unsupported file type', async () => {
    const form = ingestForm(UNSUPPORTED_BYTES, { filename: 'file.txt' });
    const res = await fetch(`${BASE_URL}/ingest`, { method: 'POST', body: form });

    if (res.status !== 400) {
        throw new Error(`Expected 400, got ${res.status}: ${await res.text()}`);
    }

    const body = await res.text();
    if (!body.includes('Cannot detect supported media type')) {
        throw new Error(`Expected error about unsupported media type, got "${body}"`);
    }
});

Deno.test('POST /ingest returns 400 for malformed tags (not JSON)', async () => {
    const form = ingestForm(MINIMAL_PNG, { tags: 'not-json' });
    const res = await fetch(`${BASE_URL}/ingest`, { method: 'POST', body: form });

    if (res.status !== 400) {
        throw new Error(`Expected 400, got ${res.status}: ${await res.text()}`);
    }

    const body = await res.text();
    if (!body.includes('Tags must be a JSON array of strings')) {
        throw new Error(`Expected error about tags format, got "${body}"`);
    }
});

Deno.test('POST /ingest returns 400 for malformed tags (not string array)', async () => {
    const form = ingestForm(MINIMAL_PNG, { tags: '[1]' });
    const res = await fetch(`${BASE_URL}/ingest`, { method: 'POST', body: form });

    if (res.status !== 400) {
        throw new Error(`Expected 400, got ${res.status}: ${await res.text()}`);
    }

    const body = await res.text();
    if (!body.includes('Tags must be a JSON array of strings')) {
        throw new Error(`Expected error about tags format, got "${body}"`);
    }
});

Deno.test('POST /ingest allows duplicate images', async () => {
    const tag = testTag('duplicate-images');

    try {
        const form1 = ingestForm(MINIMAL_PNG, { tags: JSON.stringify([tag]) });
        const res1 = await fetch(`${BASE_URL}/ingest`, { method: 'POST', body: form1 });

        if (res1.status !== 201) {
            throw new Error(`First upload: expected 201, got ${res1.status}: ${await res1.text()}`);
        }
        await res1.text();

        const form2 = ingestForm(MINIMAL_PNG, { tags: JSON.stringify([tag]) });
        const res2 = await fetch(`${BASE_URL}/ingest`, { method: 'POST', body: form2 });

        if (res2.status !== 201) {
            throw new Error(`Second upload: expected 201, got ${res2.status}: ${await res2.text()}`);
        }

        await res2.text();
    } finally {
        await deleteItemsByTag(tag);
    }
});

async function startTestServer(port: number, libPath: string, extraArgs: string[] = []): Promise<Deno.ChildProcess> {
    const cmd = new Deno.Command(Deno.execPath(), {
        args: [
            'run',
            '-A',
            '--no-check',
            './server.ts',
            '--port',
            String(port),
            '--lib',
            libPath,
            ...extraArgs,
        ],
        stdout: 'inherit',
        stderr: 'inherit',
    });
    const process = cmd.spawn();

    let attempts = 0;
    while (attempts < 50) {
        const ready = await fetch(`http://127.0.0.1:${port}/gallery`)
            .then(async (r) => {
                await r.body?.cancel();
                return r.status === 200;
            })
            .catch(() => false);
        if (ready) break;
        await new Promise((r) => setTimeout(r, 100));
        attempts++;
    }

    if (attempts === 50) {
        process.kill();
        throw new Error(`Test server failed to start on port ${port}`);
    }

    return process;
}

async function shutdownTestServer(port: number, process: Deno.ChildProcess): Promise<void> {
    await fetch(`http://127.0.0.1:${port}/shutdown`, { method: 'POST' })
        .then((r) => r.body?.cancel())
        .catch(() => {});
    await process.status.catch(() => {});
}

Deno.test('Server startup thumbnail scanning and --no-scan-thumbnail flag', async () => {
    const port = 8089;
    const tempDir = await Deno.makeTempDir({ prefix: 'booru_test_lib_' });

    const proc1 = await startTestServer(port, tempDir);

    let thumbnailOid = '';
    try {
        const form = new FormData();
        form.set('image', new File([MINIMAL_PNG.buffer as ArrayBuffer], 'test.png', { type: 'image/png' }));
        form.set('tags', JSON.stringify(['startup-test']));

        const res = await fetch(`http://127.0.0.1:${port}/ingest`, { method: 'POST', body: form });
        if (res.status !== 201) {
            throw new Error(`Failed to ingest test image: ${await res.text()}`);
        }
        await res.body?.cancel();

        const statePath = `${tempDir}/index/image_state.json`;
        const stateText = await Deno.readTextFile(statePath);
        const state = JSON.parse(stateText);
        // deno-lint-ignore no-explicit-any
        const image = Object.values(state)[0] as any;
        thumbnailOid = image.thumbnailOid;
        if (!thumbnailOid) {
            throw new Error('Ingested image has no thumbnail OID');
        }

        const thumbPath = `${tempDir}/thumbnails/${thumbnailOid}.webp`;
        const stat = await Deno.stat(thumbPath);
        if (!stat.isFile) {
            throw new Error('Thumbnail file was not written');
        }
    } finally {
        await shutdownTestServer(port, proc1);
    }

    const thumbPath = `${tempDir}/thumbnails/${thumbnailOid}.webp`;
    await Deno.remove(thumbPath);

    const proc2 = await startTestServer(port, tempDir, ['--no-scan-thumbnail']);
    try {
        const stat = await Deno.stat(thumbPath).catch(() => null);
        if (stat) {
            throw new Error('Thumbnail was generated even with --no-scan-thumbnail');
        }
    } finally {
        await shutdownTestServer(port, proc2);
    }

    const proc3 = await startTestServer(port, tempDir);
    try {
        const statePath = `${tempDir}/index/image_state.json`;
        const stateText = await Deno.readTextFile(statePath);
        const state = JSON.parse(stateText);
        // deno-lint-ignore no-explicit-any
        const image = Object.values(state)[0] as any;
        if (!image.thumbnailOid) {
            throw new Error('Thumbnail was not generated: no thumbnailOid in index');
        }
        const regeneratedThumbPath = `${tempDir}/thumbnails/${image.thumbnailOid}.jpg`;
        const stat = await Deno.stat(regeneratedThumbPath).catch(() => null);
        if (!stat || !stat.isFile) {
            throw new Error('Thumbnail file was not found on disk after startup regeneration');
        }
    } finally {
        await shutdownTestServer(port, proc3);
    }

    await Deno.remove(tempDir, { recursive: true }).catch(() => {});
});
