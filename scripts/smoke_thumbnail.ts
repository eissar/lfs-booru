/**
 * Smoke test: verify that the upload form displays a 400 response body.
 *
 * Requires the application server to already be running. Uses the same CLI/env
 * parsing as the application to find the configured port.
 *
 * Usage:
 *   deno run -A scripts/smoke_thumbnail.ts --port 8000
 */

import { chromium } from 'npm:playwright@1.57.0';
import { Buffer } from 'node:buffer';
import { getFlags } from '@/cli.ts';
import { THUMBNAIL_FFMPEG_NOT_FOUND_MESSAGE } from '@/thumbnail.ts';

const RED_PIXEL_PNG_BASE64 =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/Pchx7AAAAABJRU5ErkJggg==';

async function main() {
    const flags = getFlags();
    const baseUrl = `http://localhost:${flags.port}`;
    const browser = await chromium.launch({ headless: true });

    try {
        const page = await browser.newPage();
        await page.goto(`${baseUrl}/gallery`, { waitUntil: 'domcontentloaded' });
        await page.waitForFunction(() => 'htmx' in globalThis);

        await page.locator('#upload-button').click();
        await page.locator('#file-input').setInputFiles({
            name: 'test.png',
            mimeType: 'image/png',
            buffer: Buffer.from(RED_PIXEL_PNG_BASE64, 'base64'),
        });

        const responsePromise = page.waitForResponse((response) => {
            return response.url().includes('/ingest') && response.request().method() === 'POST';
        });

        await page.locator('#submit-button').click();

        const response = await responsePromise;
        if (response.status() !== 400) {
            throw new Error(`Expected /ingest status 400, got ${response.status()}`);
        }

        await page.waitForTimeout(3000);

        const uploadResultText = await page.locator('#upload-result').textContent();
        if (!uploadResultText?.includes(THUMBNAIL_FFMPEG_NOT_FOUND_MESSAGE)) {
            throw new Error(`Expected #upload-result to contain "${THUMBNAIL_FFMPEG_NOT_FOUND_MESSAGE}", got "${uploadResultText ?? ''}"`);
        }

        console.log('PASS');
    } finally {
        await browser.close();
    }
}

if (import.meta.main) {
    await main().catch((error) => {
        console.error(error);
        Deno.exit(1);
    });
}
