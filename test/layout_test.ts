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

        const boxes = await cards.evaluateAll((elements) => {
            return elements
                .map((element) => element.getBoundingClientRect())
                .filter((rect) => rect.width > 0 && rect.height > 0);
        });

        for (let i = 0; i < boxes.length; i++) {
            for (let j = i + 1; j < boxes.length; j++) {
                if (overlaps(boxes[i], boxes[j])) {
                    throw new Error(
                        `Cards overlap: index ${i} (${JSON.stringify(boxes[i])}) and index ${j} (${JSON.stringify(boxes[j])})`,
                    );
                }
            }
        }
    } finally {
        await browser.close();
    }
});
