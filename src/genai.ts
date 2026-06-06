const DEFAULT_API_URL = 'https://openrouter.ai/api/v1/chat/completions';
// const DEFAULT_MODEL = 'moonshotai/kimi-k2.6'; // foss, but kind of slow.
const DEFAULT_MODEL = 'bytedance-seed/seed-2.0-mini';

interface ChatCompletionResponse {
    choices?: Array<{ message?: { content?: string } }>;
}

/**
 * Convert bytes to a base64 string without spreading into function arguments.
 * Avoids exceeding the maximum call stack size for large images.
 *
 * @param bytes Raw bytes to encode.
 * @returns Base64-encoded string.
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

/**
 * Use a vision-capable language model to suggest tags for an image.
 *
 * Reads the API endpoint, model name, and API key from environment
 * variables `GENAI_API_URL`, `GENAI_MODEL`, and `OPENROUTER_API_KEY` respectively.
 *
 * @param imageBytes Raw image file bytes.
 * @param mimeType MIME type of the image (e.g. `"image/jpeg"`).
 * @returns Array of suggested tag strings, or an empty array when the API call fails.
 */
export async function suggestTags(imageBytes: Uint8Array, mimeType: string): Promise<string[]> {
    const apiUrl = Deno.env.get('GENAI_API_URL') ?? DEFAULT_API_URL;
    const model = Deno.env.get('GENAI_MODEL') ?? DEFAULT_MODEL;
    const apiKey = Deno.env.get('OPENROUTER_API_KEY');
    if (!apiKey) {
        console.error('[genai] OPENROUTER_API_KEY environment variable is not set');
        return [];
    }

    const imageDataUrl = `data:${mimeType};base64,${toBase64(imageBytes)}`;

    const res = await fetch(apiUrl, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({
            model,
            // deno-lint-ignore camelcase
            reasoning: { effort: 'none' },
            messages: [
                {
                    role: 'user',
                    content: [
                        { type: 'text', text: 'describe the attached image with a list of tags' },
                        { type: 'image_url', image_url: { url: imageDataUrl } },
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
    }).catch((err: unknown) => {
        console.error(`[genai] fetch failed: ${err instanceof Error ? err.message : String(err)}`);
        return null;
    });

    if (!res || !res.ok) {
        const body = res ? await res.text().catch(() => '') : '';
        console.error(`[genai] API returned ${res?.status ?? 'no response'}: ${body}`);
        return [];
    }

    const data: ChatCompletionResponse = await res.json().catch(() => ({}));
    const text = data.choices?.[0]?.message?.content ?? '';
    if (text.length === 0) return [];

    let tags: string[];
    try {
        tags = JSON.parse(text);
    } catch {
        console.error('[genai] Could not parse response as JSON array');
        return [];
    }

    if (!Array.isArray(tags)) return [];
    return tags.filter((t): t is string => typeof t === 'string');
}
