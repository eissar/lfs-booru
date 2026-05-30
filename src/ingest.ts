import { DerivedIndexStore } from '@/index_store.ts';
import { AddEvent } from './indexer.ts';
import { LibraryConnection as LibConn } from './library.ts';
import { startsWith } from '@std/bytes';
import { dirname, join } from '@std/path';
import { generateThumbnail } from './thumbnail.ts';
import { typeByExtension } from '@std/media-types';

const MAGIC_PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const MAGIC_JPEG = new Uint8Array([0xff, 0xd8, 0xff]);
const MAGIC_GIF_87A = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x37, 0x61]);
const MAGIC_GIF_89A = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]);
const MAGIC_RIFF = new Uint8Array([0x52, 0x49, 0x46, 0x46]);
const MAGIC_WEBP = new Uint8Array([0x57, 0x45, 0x42, 0x50]);
const MAGIC_AVI = new Uint8Array([0x41, 0x56, 0x49, 0x20]);
const MAGIC_FTYP = new Uint8Array([0x66, 0x74, 0x79, 0x70]);
const MAGIC_EBML = new Uint8Array([0x1a, 0x45, 0xdf, 0xa3]);
const MAGIC_FLV = new Uint8Array([0x46, 0x4c, 0x56]);
const MAGIC_OGG = new Uint8Array([0x4f, 0x67, 0x67, 0x53]);
const MAGIC_MPEG_PROGRAM_STREAM = new Uint8Array([0x00, 0x00, 0x01, 0xba]);
const MAGIC_MPEG_VIDEO_STREAM = new Uint8Array([0x00, 0x00, 0x01, 0xb3]);
const MAGIC_ASF = new Uint8Array([
    0x30,
    0x26,
    0xb2,
    0x75,
    0x8e,
    0x66,
    0xcf,
    0x11,
    0xa6,
    0xd9,
    0x00,
    0xaa,
    0x00,
    0x62,
    0xce,
    0x6c,
]);
const BRAND_3GP = new Uint8Array([0x33, 0x67, 0x70]);
const BRAND_AVIF = new Uint8Array([0x61, 0x76, 0x69, 0x66]);
const BRAND_M4V = new Uint8Array([0x4d, 0x34, 0x56]);
const BRAND_QT = new Uint8Array([0x71, 0x74, 0x20, 0x20]);
const DOCTYPE_MATROSKA = new Uint8Array([0x6d, 0x61, 0x74, 0x72, 0x6f, 0x73, 0x6b, 0x61]);
const DOCTYPE_WEBM = new Uint8Array([0x77, 0x65, 0x62, 0x6d]);

function isPng(fileBuffer: Uint8Array): boolean {
    return startsWith(fileBuffer, MAGIC_PNG);
}

function isJpeg(fileBuffer: Uint8Array): boolean {
    return startsWith(fileBuffer, MAGIC_JPEG);
}

function isGif(fileBuffer: Uint8Array): boolean {
    return startsWith(fileBuffer, MAGIC_GIF_87A) || startsWith(fileBuffer, MAGIC_GIF_89A);
}

function isWebp(fileBuffer: Uint8Array): boolean {
    return startsWith(fileBuffer, MAGIC_RIFF) && startsWith(fileBuffer.subarray(8), MAGIC_WEBP);
}

function isAvi(fileBuffer: Uint8Array): boolean {
    return startsWith(fileBuffer, MAGIC_RIFF) && startsWith(fileBuffer.subarray(8), MAGIC_AVI);
}

function isIsoBaseMediaFile(fileBuffer: Uint8Array): boolean {
    return startsWith(fileBuffer.subarray(4), MAGIC_FTYP);
}

function containsBytes(haystack: Uint8Array, needle: Uint8Array): boolean {
    for (let index = 0; index <= haystack.length - needle.length; index++) {
        if (startsWith(haystack.subarray(index), needle)) return true;
    }
    return false;
}

function detectIsoBaseMediaFileExtension(fileBuffer: Uint8Array): string | null {
    if (!isIsoBaseMediaFile(fileBuffer)) return null;

    const brands = fileBuffer.subarray(8, Math.min(fileBuffer.length, 64));
    if (containsBytes(brands, BRAND_AVIF)) return 'avif';
    if (containsBytes(brands, BRAND_QT)) return 'mov';
    if (containsBytes(brands, BRAND_3GP)) return '3gp';
    if (containsBytes(brands, BRAND_M4V)) return 'm4v';
    return 'mp4';
}

function detectEbmlFileExtension(fileBuffer: Uint8Array): string | null {
    if (!startsWith(fileBuffer, MAGIC_EBML)) return null;

    const header = fileBuffer.subarray(0, Math.min(fileBuffer.length, 4096));
    if (containsBytes(header, DOCTYPE_WEBM)) return 'webm';
    if (containsBytes(header, DOCTYPE_MATROSKA)) return 'mkv';
    return 'mkv';
}

export function detectMediaFileExtension(fileBuffer: Uint8Array): string | null {
    if (isPng(fileBuffer)) return 'png';
    if (isJpeg(fileBuffer)) return 'jpg';
    if (isGif(fileBuffer)) return 'gif';
    if (isWebp(fileBuffer)) return 'webp';
    if (isAvi(fileBuffer)) return 'avi';
    if (startsWith(fileBuffer, MAGIC_FLV)) return 'flv';
    if (startsWith(fileBuffer, MAGIC_OGG)) return 'ogv';
    if (startsWith(fileBuffer, MAGIC_MPEG_PROGRAM_STREAM)) return 'mpg';
    if (startsWith(fileBuffer, MAGIC_MPEG_VIDEO_STREAM)) return 'mpv';
    if (startsWith(fileBuffer, MAGIC_ASF)) return 'wmv';
    return detectIsoBaseMediaFileExtension(fileBuffer) ?? detectEbmlFileExtension(fileBuffer);
}

/**
 * Result of a pure ingest computation. No files are written to disk.
 * The caller is responsible for writing mediaBytes and thumbnailBytes
 * into the library worktree before staging and committing.
 */
export type IngestResult = {
    /** The constructed add event (includes thumbnailOid when a thumbnail was generated). */
    event: AddEvent;
    /** Raw media bytes to write to `images/{id}.{ext}`. */
    mediaBytes: Uint8Array;
    /** Raw thumbnail JPEG bytes to write to `thumbnails/{thumbOid}.jpg`. */
    thumbnailBytes: Uint8Array;
};

/**
 * Compute ingest metadata for a media file without writing to disk.
 *
 * Computes the SHA-256 OID, detects the media extension, allocates an image
 * ID, and generates a thumbnail. Returns all data the caller needs to write
 * files, append an event, and commit in one atomic scope.
 *
 * @param lib Library connection descriptor.
 * @param store Derived index store (used to allocate the image ID).
 * @param file Media file to ingest.
 * @param tags Tags to associate with the media item.
 * @param name Optional display name (defaults to `Image {id}`).
 * @param height Optional media height in pixels.
 * @param width Optional media width in pixels.
 * @param mtime Optional modification time as an ISO-8601 string.
 * @returns The add event, media bytes, and thumbnail bytes.
 */
export async function ingest(
    lib: LibConn,
    store: DerivedIndexStore,
    file: File,
    tags: string[],
    name?: string,
    height?: number,
    width?: number,
    mtime?: string,
): Promise<IngestResult> {
    const bytes = new Uint8Array(await file.arrayBuffer());

    const hashBuffer = await crypto.subtle.digest('SHA-256', bytes);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    const oid = hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');

    // don't check for duplicates; we allow duplicates
    // storage is content addressible
    // we can async check for duplicates by image signature
    // later.

    // TODO: parse image with async job to set dimensions ?
    //
    // zero is falsy
    if (!height) height = 0;
    if (!width) width = 0;

    if (!mtime) mtime = new Date().toISOString();

    const id = await store.allocateImageId();
    if (!name) name = `Image ${id}`;

    const fileExtension = detectMediaFileExtension(bytes);
    if (!fileExtension) throw new Error('Cannot detect supported media type');

    const contentType = typeByExtension(`.${fileExtension}`) ?? 'application/octet-stream';

    const event: AddEvent = {
        op: 'add',
        id: id,
        path: `images/${id}.${fileExtension}`,
        oid,
        tags,
        width,
        height,
        name,
        mtime,
        addedAt: new Date().toISOString(),
        contentType,
    };

    // Generate thumbnail without writing to disk.
    const { blob: thumbnailBlob, oid: thumbnailOid, size: thumbnailSize } = await generateThumbnail(
        bytes,
        fileExtension,
    );

    const thumbnailBytes = new Uint8Array(await thumbnailBlob.arrayBuffer());
    if (thumbnailBytes.byteLength !== thumbnailSize) {
        throw new Error(
            `Cannot generate thumbnail for image ${id}: expected ${thumbnailSize} bytes but got ${thumbnailBytes.byteLength}`,
        );
    }

    event.thumbnailOid = thumbnailOid;

    return { event, mediaBytes: bytes, thumbnailBytes };
}

/**
 * Parse a multipart form-data request and ingest the contained media file.
 *
 * Expects form fields `image` (file), `tags` (JSON string array), and
 * optionally `name`.
 *
 * @param lib Library connection descriptor.
 * @param req Incoming HTTP request with multipart form data.
 * @param store Derived index store (used to allocate the image ID).
 * @returns The add event, media bytes, and thumbnail bytes.
 */
export async function ingestFile(
    lib: LibConn,
    req: Request,
    store: DerivedIndexStore,
): Promise<IngestResult> {
    const form = await req.formData();

    const file = form.get('image') as File | null;
    if (!file) throw new Error('missing form field: image');

    const tagsRaw = (form.get('tags') as string) || '[]';

    const tags = await Promise.resolve(tagsRaw)
        .then((raw) => JSON.parse(raw))
        .then((parsed) => {
            if (!Array.isArray(parsed)) return null;
            if (!parsed.every((item) => typeof item === 'string')) return null;
            return parsed as string[];
        })
        .catch(() => null);

    if (!tags) throw new Error('tags must be a JSON array of strings');

    const name = form.get('name') as string;

    return ingest(lib, store, file, tags, name);
}
