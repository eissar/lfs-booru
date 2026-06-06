import { chromium, type Browser, type Page } from 'npm:playwright@1.57.0';

const BASE_URL = Deno.env.get('BOORU_BASE_URL') ?? 'http://127.0.0.1:8000';

// --- Shared browser session ---
let _browser: Browser | null = null;

async function getBrowser(): Promise<Browser> {
    if (!_browser) {
        console.log('[list_layout_test] launching shared Chromium instance');
        _browser = await chromium.launch({ headless: !Deno.env.get('DISPLAY') });
    }
    return _browser;
}

type TestSession = {
    readonly page: Page;
    reset(): Promise<void>;
};

function createSession(): TestSession {
    let _page: Page | undefined;

    return {
        get page(): Page {
            if (!_page) throw new Error('Cannot access session.page before calling reset()');
            return _page;
        },
        async reset(): Promise<void> {
            if (!_page) {
                const browser = await getBrowser();
                _page = await browser.newPage({ viewport: { width: 1440, height: 1200 } });
            } else {
                await _page.goto('about:blank', { waitUntil: 'domcontentloaded' }).catch(() => {});
                await _page.setViewportSize({ width: 1440, height: 1200 });
                _page.setDefaultTimeout(30_000);
            }
        },
    };
}

const sess = createSession();

/**
 * Asserts that each visible card in list view spans the full available width
 * of the #photo-grid container (within a 1px tolerance for sub-pixel rendering).
 */
Deno.test('list view cards span the full width of the photo grid', {
    sanitizeResources: false,
    sanitizeOps: false,
}, async () => {
    await sess.reset();
    const page = sess.page;
    const response = await page.goto(`${BASE_URL}/gallery`, { waitUntil: 'networkidle' });

    if (!response?.ok()) {
        throw new Error(`Cannot load gallery page: expected 200, got ${response?.status()}`);
    }

    const cards = page.locator('#photo-grid > *').filter({
        hasNot: page.locator('#pagination-controls'),
    });
    const count = await cards.count();
    if (count < 1) {
        console.log('[list_layout_test] No cards to test, skipping');
        return;
    }

    // Switch to list view
    await page.locator('label[for="gallery-view-list"]').click();
    await page.waitForTimeout(200);

    // Measure the grid container width
    const gridWidth = await page.locator('#photo-grid').evaluate((el: Element) => {
        return el.getBoundingClientRect().width;
    });

    if (gridWidth <= 0) {
        throw new Error('Photo grid has zero or negative width');
    }

    // Measure each visible card width
    const cardWidths = await cards.evaluateAll((elements: Element[]) => {
        return elements
            .map((el: Element) => el.getBoundingClientRect().width)
            .filter((w: number) => w > 0);
    });

    for (let i = 0; i < cardWidths.length; i++) {
        const diff = Math.abs(cardWidths[i] - gridWidth);
        if (diff > 1) {
            throw new Error(
                `List view card at index ${i} does not span full grid width: ` +
                `card width=${Math.round(cardWidths[i])}px, ` +
                `grid width=${Math.round(gridWidth)}px ` +
                `(diff=${Math.round(diff)}px, tolerance=1px)`,
            );
        }
    }
});
