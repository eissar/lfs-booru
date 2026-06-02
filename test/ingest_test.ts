const BASE_URL = Deno.env.get('BOORU_BASE_URL') ?? 'http://127.0.0.1:8000';

const MINIMAL_PNG = Uint8Array.from(
    atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg=='),
    (c) => c.charCodeAt(0),
);

const UNSUPPORTED_BYTES = new TextEncoder().encode('this is not a supported media file');

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
    const form = ingestForm(MINIMAL_PNG, { tags: '["delete-me"]' });
    const res = await fetch(`${BASE_URL}/ingest`, { method: 'POST', body: form });

    if (res.status !== 201) {
        throw new Error(`Expected 201, got ${res.status}: ${await res.text()}`);
    }

    const body = await res.text();
    if (body !== 'ok') {
        throw new Error(`Expected body "ok", got "${body}"`);
    }
});

Deno.test('POST /ingest returns 201 with tags and name', async () => {
    const form = ingestForm(MINIMAL_PNG, { tags: '["test", "delete-me"]', name: 'my photo' });
    const res = await fetch(`${BASE_URL}/ingest`, { method: 'POST', body: form });

    if (res.status !== 201) {
        throw new Error(`Expected 201, got ${res.status}: ${await res.text()}`);
    }

    const body = await res.text();
    if (body !== 'ok') {
        throw new Error(`Expected body "ok", got "${body}"`);
    }
});

Deno.test('POST /ingest returns 400 when image field is missing', async () => {
    const form = ingestForm(null);
    const res = await fetch(`${BASE_URL}/ingest`, { method: 'POST', body: form });

    if (res.status !== 400) {
        throw new Error(`Expected 400, got ${res.status}: ${await res.text()}`);
    }

    const body = await res.text();
    if (!body.includes('missing form field: image')) {
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
    if (!body.includes('tags must be a JSON array of strings')) {
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
    if (!body.includes('tags must be a JSON array of strings')) {
        throw new Error(`Expected error about tags format, got "${body}"`);
    }
});

Deno.test('POST /ingest allows duplicate images', async () => {
    const form1 = ingestForm(MINIMAL_PNG, { tags: '["delete-me"]' });
    const res1 = await fetch(`${BASE_URL}/ingest`, { method: 'POST', body: form1 });

    if (res1.status !== 201) {
        throw new Error(`First upload: expected 201, got ${res1.status}: ${await res1.text()}`);
    }
    await res1.text();

    const form2 = ingestForm(MINIMAL_PNG, { tags: '["delete-me"]' });
    const res2 = await fetch(`${BASE_URL}/ingest`, { method: 'POST', body: form2 });

    if (res2.status !== 201) {
        throw new Error(`Second upload: expected 201, got ${res2.status}: ${await res2.text()}`);
    }

    const body = await res2.text();
    if (body !== 'ok') {
        throw new Error(`Expected body "ok", got "${body}"`);
    }
});
