const BASE_URL = Deno.env.get('BOORU_BASE_URL') ?? 'http://127.0.0.1:8000';

async function assertStatus(res: Response, expected: number): Promise<void> {
    if (res.status !== expected) {
        throw new Error(`Expected ${expected}, got ${res.status}: ${await res.text()}`);
    }
}

async function assertHtmlResponse(res: Response, expectedText: string): Promise<string> {
    await assertStatus(res, 200);

    const contentType = res.headers.get('content-type') ?? '';
    if (!contentType.includes('text/html')) {
        throw new Error(`Expected HTML content type, got "${contentType}"`);
    }

    const body = await res.text();
    if (!body.includes(expectedText)) {
        throw new Error(`Expected response to include "${expectedText}"`);
    }
    return body;
}

Deno.test('GET /gallery returns gallery page HTML', async () => {
    const res = await fetch(`${BASE_URL}/gallery`);

    const body = await assertHtmlResponse(res, 'id="photo-grid"');
    if (!body.includes('id="search-form"')) {
        throw new Error('Expected gallery page to include search form');
    }
});

Deno.test('GET /gallery handles filter query parameters', async () => {
    const res = await fetch(`${BASE_URL}/gallery?limit=10&tags=test,second&tags=third&sort=idAsc`);

    const body = await assertHtmlResponse(res, 'id="photo-grid"');
    if (!body.includes('name="tags" value="test"')) {
        throw new Error('Expected gallery page to preserve first tag filter');
    }
    if (!body.includes('name="tags" value="third"')) {
        throw new Error('Expected gallery page to preserve repeated tag filter');
    }
});

Deno.test('GET /gallery returns error for invalid offset', async () => {
    const res = await fetch(`${BASE_URL}/gallery?offset=-1`);

    await assertStatus(res, 500);
    const body = await res.text();
    if (!body.includes('invalid offset')) {
        throw new Error(`Expected invalid offset error, got "${body}"`);
    }
});

Deno.test('GET /fragment/items returns photo grid fragment HTML', async () => {
    const res = await fetch(`${BASE_URL}/fragment/items`);

    const body = await assertHtmlResponse(res, 'id="photo-grid"');
    if (!body.includes('id="pagination-controls"')) {
        throw new Error('Expected fragment to include pagination controls');
    }
});

Deno.test('GET /fragment/items handles filter query parameters', async () => {
    const res = await fetch(`${BASE_URL}/fragment/items?limit=10&tags=test,second&tags=third&sort=idAsc`);

    await assertHtmlResponse(res, 'id="photo-grid"');
});

Deno.test('GET /fragment/items returns error for invalid offset', async () => {
    const res = await fetch(`${BASE_URL}/fragment/items?offset=-1`);

    await assertStatus(res, 500);
    const body = await res.text();
    if (!body.includes('invalid offset')) {
        throw new Error(`Expected invalid offset error, got "${body}"`);
    }
});
