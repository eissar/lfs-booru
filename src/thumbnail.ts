/**
 * Thumbnail generation for media files.
 *
 * Uses FFmpeg via mediaforge to extract and resize frames from images and videos.
 * All thumbnails are output as JPEG, scaled to fit within 320x320 while preserving
 * the original aspect ratio. Smaller inputs are not upscaled.
 */

import { ffmpeg } from 'mediaforge';

const THUMBNAIL_QUALITY = 85;

export const THUMBNAIL_FFMPEG_NOT_FOUND_MESSAGE = 'cannot generate thumbnail - ffmpeg not on PATH';

const VIDEO_FORMATS = new Set([
    'avi',
    'flv',
    'ogv',
    'mpg',
    'mpv',
    'wmv',
    'mp4',
    'mov',
    '3gp',
    'm4v',
    'webm',
    'mkv',
]);

/**
 * Whether a detected media type is a video format (as opposed to an image).
 *
 * @param mediaType Detected file extension (e.g. 'png', 'mp4', 'webm').
 * @returns `true` for video containers, `false` for still images.
 */
function isVideoFormat(mediaType: string): boolean {
    return VIDEO_FORMATS.has(mediaType);
}

/**
 * Extract a thumbnail frame from a video using FFmpeg.
 *
 * @param bytes Raw video file bytes.
 * @returns JPEG thumbnail as a Blob.
 */
async function extractVideoThumbnail(_bytes: Uint8Array): Promise<Blob> {
    // Write video bytes to a temporary file for FFmpeg to read.
    // FFmpeg cannot read from stdin directly for most formats, so we use a temp file.
    const tmpVideoPath = await Deno.makeTempFile({ prefix: 'thumb_video_', suffix: '.tmp' });
    await Deno.writeFile(tmpVideoPath, _bytes);

    const tmpOutputPath = await Deno.makeTempFile({ prefix: 'thumb_video_out_', suffix: '.jpg' });

    try {
        await ffmpeg(tmpVideoPath)
            .seekInput(1) // 1 second in (safe for most videos)
            .output(tmpOutputPath)
            .videoFilter(
                "scale='min(320,iw)':'min(320,ih)':force_original_aspect_ratio=decrease",
            )
            .addOutputOption('-vframes', '1')
            .addOutputOption('-q:v', String(Math.round((100 - THUMBNAIL_QUALITY) * 1.28)))
            .run();

        const outputBytes = await Deno.readFile(tmpOutputPath);
        // Slice to ensure ArrayBuffer backing (not SharedArrayBuffer).
        const ab = outputBytes.slice().buffer as ArrayBuffer;
        return new Blob([new Uint8Array(ab)], { type: 'image/jpeg' });
    } finally {
        await Deno.remove(tmpVideoPath).catch(() => {
            // Ignore cleanup errors
        });
        await Deno.remove(tmpOutputPath).catch(() => {
            // Ignore cleanup errors
        });
    }
}

/**
 * Resize an image to thumbnail dimensions using FFmpeg.
 *
 * @param bytes Raw image file bytes.
 * @returns JPEG thumbnail as a Blob.
 */
async function resizeImageThumbnail(_bytes: Uint8Array): Promise<Blob> {
    const tmpImagePath = await Deno.makeTempFile({ prefix: 'thumb_image_', suffix: '.tmp' });
    const tmpOutputPath = await Deno.makeTempFile({ prefix: 'thumb_out_', suffix: '.jpg' });

    await Deno.writeFile(tmpImagePath, _bytes);

    try {
        await ffmpeg(tmpImagePath)
            .output(tmpOutputPath)
            .videoFilter(
                "scale='min(320,iw)':'min(320,ih)':force_original_aspect_ratio=decrease",
            )
            .addOutputOption('-q:v', String(Math.round((100 - THUMBNAIL_QUALITY) * 1.28)))
            .run();

        const outputBytes = await Deno.readFile(tmpOutputPath);
        // Slice to ensure ArrayBuffer backing (not SharedArrayBuffer).
        const ab = outputBytes.slice().buffer as ArrayBuffer;
        return new Blob([new Uint8Array(ab)], { type: 'image/jpeg' });
    } finally {
        await Deno.remove(tmpImagePath).catch(() => {
            // Ignore cleanup errors
        });
        await Deno.remove(tmpOutputPath).catch(() => {
            // Ignore cleanup errors
        });
    }
}

/**
 * Generate a thumbnail for a media file.
 *
 * For video formats, seeks to 1 second and extracts a single frame.
 * For image formats, resizes to the thumbnail size.
 * All output is JPEG for maximum browser compatibility.
 *
 * @param bytes Raw media file bytes.
 * @param mediaType Detected media type extension (e.g. 'png', 'mp4').
 * @returns Thumbnail Blob, SHA-256 OID, and byte size.
 */
export async function generateThumbnail(
    bytes: Uint8Array,
    mediaType: string,
): Promise<{ blob: Blob; oid: string; size: number }> {
    const isVideo = isVideoFormat(mediaType);
    let thumbnailBlob: Blob;
    if (isVideo) {
        thumbnailBlob = await extractVideoThumbnail(bytes).catch((err) => {
            const msg = err instanceof Error ? err.message : String(err);
            if (msg.includes('ENOENT') || msg.includes('spawn') || msg.includes('ffmpeg')) {
                throw new Error(THUMBNAIL_FFMPEG_NOT_FOUND_MESSAGE);
            }
            throw new Error(`thumbnail generation failed: ${msg}`);
        });
    } else {
        thumbnailBlob = await resizeImageThumbnail(bytes).catch((err) => {
            const msg = err instanceof Error ? err.message : String(err);
            if (msg.includes('ENOENT') || msg.includes('spawn') || msg.includes('ffmpeg')) {
                throw new Error(THUMBNAIL_FFMPEG_NOT_FOUND_MESSAGE);
            }
            throw new Error(`thumbnail generation failed: ${msg}`);
        });
    }

    // Slice to ensure ArrayBuffer backing for crypto.subtle.digest.
    const thumbnailBytes = new Uint8Array(await thumbnailBlob.arrayBuffer());
    const hashBuffer = await crypto.subtle.digest('SHA-256', thumbnailBytes);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    const oid = hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');

    return {
        blob: thumbnailBlob,
        oid,
        size: thumbnailBlob.size,
    };
}
