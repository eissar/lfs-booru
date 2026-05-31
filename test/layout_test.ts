import { chromium, type Page } from 'npm:playwright@1.57.0';

const BASE_URL = Deno.env.get('BOORU_BASE_URL') ?? 'http://127.0.0.1:8000';

function overlaps(a: DOMRect, b: DOMRect): boolean {
    return !(a.right <= b.left || b.right <= a.left || a.bottom <= b.top || b.bottom <= a.top);
}

type CardLayoutSnapshot = {
    id: string;
    column: number;
    left: number;
    top: number;
    width: number;
    height: number;
};

async function captureMasonryCardLayout(page: Page): Promise<CardLayoutSnapshot[]> {
    return await page.evaluate(() => {
        const grid = document.getElementById('photo-grid');
        if (!grid) throw new Error('Cannot snapshot masonry cards: #photo-grid missing');

        const gridRect = grid.getBoundingClientRect();
        const columns = Array.from(document.querySelectorAll<HTMLElement>('#photo-grid > .masonry-column'));

        return Array.from(document.querySelectorAll<HTMLElement>('#photo-grid article.masonry-item')).map((article) => {
            const id = article.dataset.imageId;
            if (!id) throw new Error('Cannot snapshot masonry card: data-image-id missing');

            const column = columns.indexOf(article.parentElement as HTMLElement);
            if (column < 0) throw new Error(`Cannot snapshot masonry card "${id}": card is not in a masonry column`);

            const rect = article.getBoundingClientRect();
            return {
                id,
                column,
                left: Math.round(rect.left - gridRect.left),
                top: Math.round(rect.top - gridRect.top),
                width: Math.round(rect.width),
                height: Math.round(rect.height),
            };
        });
    });
}

function assertStableMasonryCards(
    before: CardLayoutSnapshot[],
    after: CardLayoutSnapshot[],
    context: string,
): void {
    const afterById = new Map(after.map((snapshot) => [snapshot.id, snapshot]));

    for (const expected of before) {
        const actual = afterById.get(expected.id);
        if (!actual) throw new Error(`${context}: card "${expected.id}" missing after append`);

        if (actual.column !== expected.column) {
            throw new Error(
                `${context}: card "${expected.id}" moved columns: expected ${expected.column}, got ${actual.column}`,
            );
        }

        for (const property of ['left', 'top', 'width', 'height'] as const) {
            if (Math.abs(actual[property] - expected[property]) > 1) {
                throw new Error(
                    `${context}: card "${expected.id}" changed ${property}: expected ${expected[property]}, got ${
                        actual[property]
                    }`,
                );
            }
        }
    }
}

async function assertNextMasonryAppendIsAdditive(page: Page, context: string): Promise<boolean> {
    const button = page.locator('#pagination-controls button');
    if (await button.count() === 0) return false;

    const before = await captureMasonryCardLayout(page);
    if (before.length < 2) return false;

    await button.click();
    await page.waitForFunction((count) => {
        const total = document.querySelectorAll('#photo-grid article.masonry-item').length;
        const pending = document.querySelectorAll('#photo-grid > article.masonry-item').length;
        return total > count && pending === 0;
    }, before.length);

    const after = await captureMasonryCardLayout(page);
    if (after.length <= before.length) {
        throw new Error(`${context}: append did not add cards: before ${before.length}, after ${after.length}`);
    }

    assertStableMasonryCards(before, after, context);
    return true;
}

Deno.test('cards in #photo-grid do not overlap', async () => {
    const browser = await chromium.launch({ headless: !Deno.env.get('DISPLAY') });

    try {
        const page = await browser.newPage({ viewport: { width: 1440, height: 1200 } });
        const response = await page.goto(`${BASE_URL}/gallery`, { waitUntil: 'networkidle' });

        if (!response?.ok()) {
            throw new Error(`Cannot load gallery page: expected 200, got ${response?.status()}`);
        }

        const cards = page.locator('#photo-grid > *').filter({ hasNot: page.locator('#pagination-controls') });
        const count = await cards.count();
        if (count < 2) return;

        const boxes = await cards.evaluateAll((elements: Element[]) => {
            return elements
                .map((element: Element) => element.getBoundingClientRect())
                .filter((rect: DOMRect) => rect.width > 0 && rect.height > 0);
        });

        for (let i = 0; i < boxes.length; i++) {
            for (let j = i + 1; j < boxes.length; j++) {
                if (overlaps(boxes[i], boxes[j])) {
                    throw new Error(
                        `Cards overlap: index ${i} (${JSON.stringify(boxes[i])}) and index ${j} (${
                            JSON.stringify(boxes[j])
                        })`,
                    );
                }
            }
        }
    } finally {
        await browser.close();
    }
});

Deno.test('cards in #photo-grid do not overlap in grid view', async () => {
    const browser = await chromium.launch({ headless: !Deno.env.get('DISPLAY') });

    try {
        const page = await browser.newPage({ viewport: { width: 1440, height: 1200 } });
        const response = await page.goto(`${BASE_URL}/gallery`, { waitUntil: 'networkidle' });

        if (!response?.ok()) {
            throw new Error(`Cannot load gallery page: expected 200, got ${response?.status()}`);
        }

        const cards = page.locator('#photo-grid > *').filter({ hasNot: page.locator('#pagination-controls') });
        const count = await cards.count();
        if (count < 2) return;

        await page.locator('label[for="gallery-view-grid"]').click();
        await page.waitForTimeout(100);

        const boxes = await cards.evaluateAll((elements: Element[]) => {
            return elements
                .map((element: Element) => element.getBoundingClientRect())
                .filter((rect: DOMRect) => rect.width > 0 && rect.height > 0);
        });

        for (let i = 0; i < boxes.length; i++) {
            for (let j = i + 1; j < boxes.length; j++) {
                if (overlaps(boxes[i], boxes[j])) {
                    throw new Error(
                        `Grid view cards overlap: index ${i} (${JSON.stringify(boxes[i])}) and index ${j} (${
                            JSON.stringify(boxes[j])
                        })`,
                    );
                }
            }
        }
    } finally {
        await browser.close();
    }
});

Deno.test('cards in #photo-grid do not overlap in list view and share a single column', async () => {
    const browser = await chromium.launch({ headless: !Deno.env.get('DISPLAY') });

    try {
        const page = await browser.newPage({ viewport: { width: 1440, height: 1200 } });
        const response = await page.goto(`${BASE_URL}/gallery`, { waitUntil: 'networkidle' });

        if (!response?.ok()) {
            throw new Error(`Cannot load gallery page: expected 200, got ${response?.status()}`);
        }

        const cards = page.locator('#photo-grid > *').filter({ hasNot: page.locator('#pagination-controls') });
        const count = await cards.count();
        if (count < 2) return;

        await page.locator('label[for="gallery-view-list"]').click();
        await page.waitForTimeout(100);

        const boxes = await cards.evaluateAll((elements: Element[]) => {
            return elements
                .map((element: Element) => element.getBoundingClientRect())
                .filter((rect: DOMRect) => rect.width > 0 && rect.height > 0);
        });

        for (let i = 0; i < boxes.length; i++) {
            for (let j = i + 1; j < boxes.length; j++) {
                if (overlaps(boxes[i], boxes[j])) {
                    throw new Error(
                        `List view cards overlap: index ${i} (${JSON.stringify(boxes[i])}) and index ${j} (${
                            JSON.stringify(boxes[j])
                        })`,
                    );
                }
            }
        }

        const lefts = boxes.map((b: DOMRect) => Math.round(b.left));
        const firstLeft = lefts[0];
        for (let i = 1; i < lefts.length; i++) {
            if (Math.abs(lefts[i] - firstLeft) > 1) {
                throw new Error(
                    `List view cards not in single column: index 0 left=${firstLeft}, index ${i} left=${lefts[i]}`,
                );
            }
        }
    } finally {
        await browser.close();
    }
});

Deno.test('inspector panel opens and closes without breaking layout', async () => {
    const browser = await chromium.launch({ headless: !Deno.env.get('DISPLAY') });

    try {
        const page = await browser.newPage({ viewport: { width: 1440, height: 1200 } });
        const response = await page.goto(`${BASE_URL}/gallery`, { waitUntil: 'networkidle' });

        if (!response?.ok()) {
            throw new Error(`Cannot load gallery page: expected 200, got ${response?.status()}`);
        }

        const cards = page.locator('#photo-grid > *').filter({ hasNot: page.locator('#pagination-controls') });
        const count = await cards.count();
        if (count < 2) return;

        const grid = page.locator('#photo-grid');

        await page.locator('#inspector-toggle').click();
        await page.waitForTimeout(200);

        const main = page.locator('#gallery-main');
        const hasOpenClass = await main.evaluate((el: Element) => el.classList.contains('inspector-open'));
        if (!hasOpenClass) {
            throw new Error('Inspector did not open: #gallery-main missing inspector-open class');
        }

        const inspectorWidth = await page.locator('.inspector').evaluate(
            (el: Element) => el.getBoundingClientRect().width,
        );
        if (inspectorWidth < 100) {
            throw new Error(`Inspector width too small after open: ${inspectorWidth}px`);
        }

        const gridBox = await grid.evaluate((el: Element) => el.getBoundingClientRect());
        if (gridBox.right > page.viewportSize()!.width!) {
            throw new Error(
                `Photo grid extends beyond viewport when inspector open: grid.right=${gridBox.right}, viewport=${
                    page.viewportSize()!.width
                }`,
            );
        }

        const boxes = await cards.evaluateAll((elements: Element[]) => {
            return elements
                .map((element: Element) => element.getBoundingClientRect())
                .filter((rect: DOMRect) => rect.width > 0 && rect.height > 0);
        });
        for (let i = 0; i < boxes.length; i++) {
            for (let j = i + 1; j < boxes.length; j++) {
                if (overlaps(boxes[i], boxes[j])) {
                    throw new Error(
                        `Cards overlap with inspector open: index ${i} (${JSON.stringify(boxes[i])}) and index ${j} (${
                            JSON.stringify(boxes[j])
                        })`,
                    );
                }
            }
        }

        await page.locator('.inspector-header button').click();
        await page.waitForTimeout(200);

        const stillOpen = await main.evaluate((el: Element) => el.classList.contains('inspector-open'));
        if (stillOpen) {
            throw new Error('Inspector did not close: #gallery-main still has inspector-open class');
        }

        const closedWidth = await page.locator('.inspector').evaluate(
            (el: Element) => el.getBoundingClientRect().width,
        );
        if (closedWidth > 1) {
            throw new Error(`Inspector width not zero after close: ${closedWidth}px`);
        }
    } finally {
        await browser.close();
    }
});

Deno.test('masonry appends do not move existing cards', async () => {
    const browser = await chromium.launch({ headless: !Deno.env.get('DISPLAY') });

    try {
        const page = await browser.newPage({ viewport: { width: 1440, height: 1200 } });
        let response = await page.goto(`${BASE_URL}/gallery`, { waitUntil: 'networkidle' });
        if (!response?.ok()) {
            throw new Error(`Cannot load gallery page: expected 200, got ${response?.status()}`);
        }

        const testedInitialAppend = await assertNextMasonryAppendIsAdditive(page, 'initial masonry append');
        if (!testedInitialAppend) return;

        response = await page.goto(`${BASE_URL}/gallery`, { waitUntil: 'networkidle' });
        if (!response?.ok()) {
            throw new Error(`Cannot reload gallery page: expected 200, got ${response?.status()}`);
        }

        await page.setViewportSize({ width: 640, height: 1200 });
        await page.waitForTimeout(200);
        await page.setViewportSize({ width: 1400, height: 1200 });
        await page.waitForTimeout(200);
        await page.locator('label[for="gallery-view-grid"]').click();
        await page.waitForTimeout(100);
        await page.locator('label[for="gallery-view-list"]').click();
        await page.waitForTimeout(100);
        await page.locator('label[for="gallery-view-masonry"]').click();
        await page.waitForTimeout(100);

        await assertNextMasonryAppendIsAdditive(page, 'masonry append after resize and view changes');
    } finally {
        await browser.close();
    }
});

Deno.test('each masonry column contains at least one card when enough cards exist', async () => {
    const testCases = [
        { width: 640, height: 1200, expected: 2 },
        { width: 1400, height: 1200, expected: 5 },
    ];

    const browser = await chromium.launch({ headless: !Deno.env.get('DISPLAY') });
    try {
        const page = await browser.newPage({ viewport: { width: 1440, height: 1200 } });
        const response = await page.goto(`${BASE_URL}/gallery`, { waitUntil: 'networkidle' });
        if (!response?.ok()) {
            throw new Error(`Cannot load gallery page: expected 200, got ${response?.status()}`);
        }

        for (const { width, height, expected: columns } of testCases) {
            await page.setViewportSize({ width, height });
            await page.waitForTimeout(200);
            await page.evaluate(() => (globalThis as any).booruLayoutMasonry?.());
            await page.waitForTimeout(100);

            const cardCount = await page.evaluate(() => {
                return document.querySelectorAll('#photo-grid article.masonry-item').length;
            });

            if (cardCount < columns) continue;

            const emptyColumns = await page.evaluate(() => {
                const cols = document.querySelectorAll<HTMLElement>('#photo-grid > .masonry-column');
                const empty: number[] = [];
                cols.forEach((col, i) => {
                    if (col.querySelectorAll('article.masonry-item').length === 0) {
                        empty.push(i);
                    }
                });
                return empty;
            });

            if (emptyColumns.length > 0) {
                throw new Error(
                    `At ${width}px width (${columns} columns): columns [${emptyColumns}] have zero cards despite ${cardCount} cards available`,
                );
            }
        }
    } finally {
        await browser.close();
    }
});

Deno.test('photo-grid respects responsive column counts', async () => {
    const testCases = [
        { width: 640, height: 1200, expected: 2 },
        { width: 800, height: 1200, expected: 3 },
        { width: 1100, height: 1200, expected: 4 },
        { width: 1400, height: 1200, expected: 5 },
    ];

    const browser = await chromium.launch({ headless: !Deno.env.get('DISPLAY') });
    try {
        const page = await browser.newPage({ viewport: { width: 1440, height: 1200 } });
        const response = await page.goto(`${BASE_URL}/gallery`, { waitUntil: 'networkidle' });
        if (!response?.ok()) {
            throw new Error(`Cannot load gallery page: expected 200, got ${response?.status()}`);
        }

        for (const { width, height, expected } of testCases) {
            await page.setViewportSize({ width, height });
            await page.waitForTimeout(200);
            await page.evaluate(() => (globalThis as any).booruLayoutMasonry?.());
            await page.waitForTimeout(100);

            const actual = await page.evaluate(() => {
                const grid = document.getElementById('photo-grid');
                if (!grid) return null;
                const raw = getComputedStyle(grid).getPropertyValue('--masonry-columns').trim();
                return Number.parseInt(raw, 10);
            });

            if (actual !== expected) {
                throw new Error(
                    `At ${width}px width: expected --masonry-columns=${expected}, got ${actual}`,
                );
            }

            const columnCount = await page.evaluate(() => {
                return document.querySelectorAll('#photo-grid > .masonry-column').length;
            });

            if (columnCount !== expected) {
                throw new Error(
                    `At ${width}px width: expected ${expected} .masonry-column elements, got ${columnCount}`,
                );
            }
        }
    } finally {
        await browser.close();
    }
});
