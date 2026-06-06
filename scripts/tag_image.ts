import { extname, resolve } from '@std/path';

/**
 * Convert bytes to a base64 string without spreading into function arguments.
 * Avoids exceeding the maximum call stack size for large images.
 */
function toBase64(bytes: Uint8Array): string {
    const CHUNK_SIZE = 0x8000;
    let binary = '';
    for (let i = 0; i < bytes.length; i += CHUNK_SIZE) {
        const chunk = bytes.subarray(i, Math.min(i + CHUNK_SIZE, bytes.length));
        binary += String.fromCharCode(...chunk);
    }
    return btoa(binary);
}

const EXT_MEDIA_TYPES: Record<string, string> = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.avif': 'image/avif',
    '.bmp': 'image/bmp',
    '.tiff': 'image/tiff',
    '.tif': 'image/tiff',
};

if (Deno.args.length === 0) {
    console.error('Usage: deno run -A scripts/tag_image.ts <filepath>');
    Deno.exit(1);
}

const filepath = resolve(Deno.args[0]);

let imageBytes: Uint8Array;
try {
    imageBytes = await Deno.readFile(filepath);
} catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`Cannot read file "${filepath}": ${message}`);
    Deno.exit(1);
}

const ext = extname(filepath).toLowerCase();
const mediaType = EXT_MEDIA_TYPES[ext];
if (!mediaType) {
    console.error(`Cannot determine media type for extension "${ext}"`);
    Deno.exit(1);
}

const apiKey = Deno.env.get('OPENROUTER_API_KEY');
if (!apiKey) {
    console.error('OPENROUTER_API_KEY environment variable is not set');
    Deno.exit(1);
}

const imageDataUrl = `data:${mediaType};base64,${toBase64(imageBytes)}`;

const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
    },
    body: JSON.stringify({
        model: 'moonshotai/kimi-k2.6',
        // deno-lint-ignore camelcase
        reasoning: { effort: 'none' },
        messages: [
            {
                role: 'user',
                content: [
                    {
                        type: 'text',
                        text: 'describe the attached image with a list of tags',
                    },
                    {
                        type: 'image_url',
                        image_url: { url: imageDataUrl },
                    },
                ],
            },
        ],
        response_format: {
            type: 'json_schema',
            json_schema: {
                name: 'image_tags',
                strict: true,
                schema: {
                    type: 'array',
                    items: { type: 'string' },
                },
            },
        },
    }),
});

if (!response.ok) {
    const body = await response.text();
    console.error(`OpenRouter request failed (${response.status}): ${body}`);
    Deno.exit(1);
}

const result = await response.json();
const text: string = result.choices?.[0]?.message?.content ?? '';

if (text.length === 0) {
    console.error('No content in OpenRouter response');
    Deno.exit(1);
}

const tags: string[] = JSON.parse(text);
console.log(JSON.stringify(tags, null, 2));
