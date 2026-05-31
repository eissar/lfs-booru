import { chromium } from 'npm:playwright@1.57.0';

const BASE_URL = Deno.env.get('BOORU_BASE_URL') ?? 'http://127.0.0.1:8000';

function overlaps(a: DOMRect, b: DOMRect): boolean {
    return !(a.right <= b.left || b.right <= a.left || a.bottom <= b.top || b.bottom <= a.top);
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
