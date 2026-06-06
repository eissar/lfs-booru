import { serveDir } from '@std/http/file-server';
import { dirname, join } from '@std/path';
import { typeByExtension } from '@std/media-types';

import { GitConstructError, GitError, simpleGit, TaskConfigurationError } from 'simple-git';

import { getFlags } from '@/cli.ts';
import type { EventLog, EventLogReader } from '@/event_log.ts';
import { NdjsonEventLog } from '@/event_log.ts';
import { Init, stageAndCommit } from '@/git.ts';
import { DeletedFilter, DerivedIndexStore, ItemsFilter, ItemSort, JsonFileIndexStore } from '@/index_store.ts';
import { type DeleteEvent, processEvents, type RegenThumbnailEvent, type UpdateMetadataEvent } from '@/indexer.ts';
import { ingest } from '@/ingest.ts';
import { detectMediaFileExtension } from '@/ingest.ts';
import { ingestFromEagleSource } from '@/eagle-import.ts';
import { LibraryConnection as LibConn } from '@/library.ts';
import { debug, trace } from '@/logging.ts';
import { CachingHtmlRenderer, HtmlRenderer } from '@/renderer.tsx';
import { suggestTags } from '@/genai.ts';
import { c, isInt } from '@/util.ts';
import { tryReadPointerSize } from '@/pointer.ts';
import { generateThumbnail } from '@/thumbnail.ts';
import { ItemCard } from '@/template/ItemCard.tsx';

const MIN_LIMIT = 10;

/**
 * Parse a human search query into structured gallery query parameters.
 *
 * @param query Raw search query text.
 * @returns URL search parameters with `keyword` and repeated `tags` entries.
 */
function parseSearchQuery(query: string): URLSearchParams {
    const params = new URLSearchParams();
    const keywordTokens: string[] = [];

    for (const token of query.split(/\s+/).map((part) => part.trim()).filter((part) => part.length > 0)) {
        if (token.startsWith('#') && token.length > 1) {
            params.append('tags', token.slice(1));
            continue;
        }

        keywordTokens.push(token);
    }

    const keyword = keywordTokens.join(' ').trim();
    if (keyword) params.set('keyword', keyword);

    return params;
}

export const itemSortParameterMap: Record<string, ItemSort> = {
    'idAsc': { field: 'id', direction: 1 },
    'idDesc': { field: 'id', direction: -1 },
    'addedAtAsc': { field: 'addedAt', direction: 1 },
    'addedAtDesc': { field: 'addedAt', direction: -1 },
};

export async function reloadThumbnail(
    lib: LibConn,
    store: DerivedIndexStore,
    id: string,
    fileExtension: string,
): Promise<{ oid: string; size: number; contentType: string }> {
    // Read the original media file bytes.
    const image = await store.getImage(id);
    if (!image) throw new Error(`Could not find image state for id "${id}"`);

    const mediaPath = join(lib.path, image.path);
    const bytes = await Deno.readFile(mediaPath);

    const detectedExtension = detectMediaFileExtension(bytes);
    const contentType = detectedExtension
        ? typeByExtension(`.${detectedExtension}`) ?? 'application/octet-stream'
        : 'application/octet-stream';

    // Generate a fresh thumbnail.
    const { blob: thumbnailBlob, oid: thumbnailOid, size: thumbnailSize } = await generateThumbnail(
        bytes,
        fileExtension,
    );

    // Write the new thumbnail.
    const thumbnailBytes = new Uint8Array(await thumbnailBlob.arrayBuffer());
    const thumbnailPath = join(lib.path, 'thumbnails', `${thumbnailOid}.jpg`);
    await Deno.mkdir(dirname(thumbnailPath), { recursive: true });
    await Deno.writeFile(thumbnailPath, thumbnailBytes);

    return { oid: thumbnailOid, size: thumbnailSize, contentType };
}

/**
 * Convert an item filter to URL search parameters.
 *
 * @param filter Item listing filter to serialize.
 * @param sortParameterMap Mapping from URL sort parameter values to item sort definitions.
 * @returns URL search parameters representing the filter.
 */
export function itemFilterToSearchParams(
    filter: ItemsFilter,
    sortParameterMap: Record<string, ItemSort> = itemSortParameterMap,
): URLSearchParams {
    const params = new URLSearchParams();

    params.set('limit', String(filter.limit));

    for (const tag of filter.tags ?? []) {
        params.append('tags', tag);
    }

    if (filter.offset !== undefined) {
        params.set('offset', String(filter.offset));
    }

    if (filter.sort !== undefined) {
        const sortParameter = Object.entries(sortParameterMap).find(([, sort]) => {
            return sort.field === filter.sort?.field && sort.direction === filter.sort.direction;
        })?.[0];

        if (sortParameter === undefined) {
            throw new Error(
                `Cannot serialize item sort: current sort is ${
                    JSON.stringify(filter.sort)
                }, desired sort must exist in sort parameter map`,
            );
        }

        params.set('sort', sortParameter);
    }

    if (filter.deleted !== undefined && filter.deleted !== 'no') {
        params.set('deleted', filter.deleted);
    }

    return params;
}

async function handleUiRoutes(url: URL, store: DerivedIndexStore, render: HtmlRenderer): Promise<void | Response> {
    // search
    if (url.pathname === '/gallery' && url.searchParams.has('q')) {
        const queryString = url.searchParams.get('q');
        if (!queryString) return c.error('invalid query');

        const params = parseSearchQuery(queryString);

        return c.redirect(new URL(`/gallery?${params}`, url.origin));
    }
    if (url.pathname === '/gallery') {
        let limit = Number(url.searchParams.get('limit'));
        if (!isInt(limit) || limit < MIN_LIMIT) limit = MIN_LIMIT;

        let offset: number | false = false;
        if (url.searchParams.has('offset')) {
            offset = Number(url.searchParams.get('offset'));
            if (!isInt(offset) || offset < 0) return c.error('invalid offset');
        }

        const tags = url.searchParams.getAll('tags')
            .flatMap((value) => value.split(','))
            .map((tag) => tag.trim())
            .filter((tag) => tag.length > 0);

        let sort: ItemSort = itemSortParameterMap['idDesc'];
        if (url.searchParams.has('sort')) {
            const match = itemSortParameterMap[url.searchParams.get('sort') ?? ''];
            if (match !== undefined) sort = match;
        }

        let deleted: DeletedFilter = 'no';
        if (url.searchParams.has('deleted')) {
            const raw = url.searchParams.get('deleted') ?? '';
            if (raw === 'yes' || raw === 'both') deleted = raw;
        }

        const requestSearch: ItemsFilter = { limit, tags, sort };
        if (deleted !== 'no') requestSearch.deleted = deleted;

        const search: ItemsFilter = { ...requestSearch };
        const listedLimit = offset || requestSearch.limit;
        // always list an extra
        // so we can check if
        // there are more items left
        search.limit = listedLimit;
        search.limit++;

        const itemsList = store.listItems(search);

        const cards = [];
        let hasMore = false;

        let listed = 0;
        for await (const [id, img] of itemsList) {
            if (listed >= listedLimit) {
                hasMore = true;
                break;
            }

            cards.push(ItemCard({ image: { ...img, id }, renderOrder: listed }));
            listed++;
        }

        offset = listed;

        return c.html(
            await render.renderGalleryPage({
                filter: requestSearch,
                title: 'Gallery',
                photoGridParam: { cards, offset: String(offset), hasMore },
            }),
        );
    }

    if (url.pathname.startsWith('/fragment/inspect/')) {
        const id = url.pathname.split('/')[3];
        if (!id) {
            return c.html(
                await render.renderToast({ message: 'Missing image id', variant: 'error' }),
                400,
                { 'HX-Reswap': 'beforeend' },
            );
        }
        const img = await store.getImage(id);
        if (!img) {
            return c.html(
                await render.renderToast({ message: 'Could not find image', variant: 'error' }),
                404,
                { 'HX-Reswap': 'beforeend' },
            );
        }
        return c.html(await render.renderInspector({ ...img, id }));
    }

    if (url.pathname === '/fragment/items') {
        let limit = Number(url.searchParams.get('limit'));
        if (!isInt(limit) || limit < MIN_LIMIT) limit = MIN_LIMIT;

        let offset: number | false = false;
        if (url.searchParams.has('offset')) {
            offset = Number(url.searchParams.get('offset'));
            if (!isInt(offset) || offset < 0) return c.error('invalid offset');
        }

        const tags = url.searchParams.getAll('tags')
            .flatMap((value) => value.split(','))
            .map((tag) => tag.trim())
            .filter((tag) => tag.length > 0);

        // default to idDesc
        let sort: ItemSort = itemSortParameterMap['idDesc'];
        if (url.searchParams.has('sort')) {
            const match = itemSortParameterMap[url.searchParams.get('sort') ?? ''];
            if (match !== undefined) sort = match;
        }

        let deleted: DeletedFilter = 'no';
        if (url.searchParams.has('deleted')) {
            const raw = url.searchParams.get('deleted') ?? '';
            if (raw === 'yes' || raw === 'both') deleted = raw;
        }

        const requestSearch: ItemsFilter = {
            limit,
            tags,
            sort,
        };
        if (deleted !== 'no') requestSearch.deleted = deleted;

        const search: ItemsFilter = { ...requestSearch };
        if (offset) {
            search.offset = offset;
            search.limit = offset + limit;
        }
        search.limit++;

        const itemsList = store.listItems(search);

        const cards = [];
        let hasMore = false;
        let listed = 0;
        for await (const [id, img] of itemsList) {
            if (listed >= requestSearch.limit) {
                hasMore = true;
                break;
            }

            const image = { ...img, id: id };
            if (img.oid) cards.push(ItemCard({ image: image, renderOrder: listed }));
            listed++;
        }

        if (offset) offset = offset + listed;
        else offset = listed;

        url.searchParams.set('offset', String(offset));
        const pushUrl = `/gallery?${url.searchParams.toString()}`;

        return c.html(
            await render.renderCardGrid({
                cards: cards,
                offset: String(offset),
                hasMore,
            }),
            200,
            { 'HX-Push-Url': pushUrl },
        );
    }

    if (url.pathname === '/fragment/gallery-content') {
        let limit = Number(url.searchParams.get('limit'));
        if (!isInt(limit) || limit < MIN_LIMIT) limit = MIN_LIMIT;

        let offset: number | false = false;
        if (url.searchParams.has('offset')) {
            offset = Number(url.searchParams.get('offset'));
            if (!isInt(offset) || offset < 0) return c.error('invalid offset');
        }

        const tags = [
            ...new Set(
                url.searchParams.getAll('tags')
                    .flatMap((value) => value.split(','))
                    .map((tag) => tag.trim())
                    .filter((tag) => tag.length > 0),
            ),
        ];

        let sort: ItemSort = itemSortParameterMap['idDesc'];
        if (url.searchParams.has('sort')) {
            const match = itemSortParameterMap[url.searchParams.get('sort') ?? ''];
            if (match !== undefined) sort = match;
        }

        let deleted: DeletedFilter = 'no';
        if (url.searchParams.has('deleted')) {
            const raw = url.searchParams.get('deleted') ?? '';
            if (raw === 'yes' || raw === 'both') deleted = raw;
        }

        const requestSearch: ItemsFilter = { limit, tags, sort };
        if (deleted !== 'no') requestSearch.deleted = deleted;

        const search: ItemsFilter = { ...requestSearch };
        const listedLimit = offset || requestSearch.limit;
        search.limit = listedLimit;
        search.limit++;

        const itemsList = store.listItems(search);

        const cards = [];
        let hasMore = false;
        let listed = 0;
        for await (const [id, img] of itemsList) {
            if (listed >= listedLimit) {
                hasMore = true;
                break;
            }

            cards.push(ItemCard({ image: { ...img, id }, renderOrder: listed }));
            listed++;
        }

        offset = listed;

        const canonicalParams = itemFilterToSearchParams(requestSearch);
        const pushUrl = `/gallery?${canonicalParams.toString()}`;

        return c.html(
            await render.renderGalleryContent({
                filter: requestSearch,
                photoGridParam: { cards, offset: String(offset), hasMore },
            }),
            200,
            { 'HX-Push-Url': pushUrl },
        );
    }
}

function createHandler(
    store: DerivedIndexStore,
    eventLog: EventLog & EventLogReader,
    lib: LibConn,
    render: HtmlRenderer,
    abortController: AbortController,
): (req: Request) => Promise<Response> {
    return async (req: Request): Promise<Response> => {
        const url = new URL(req.url);

        console.log(
            `[request] method=${req.method} path=${url.pathname} query=${url.search}`,
        );

        if (url.pathname === '/shutdown' && req.method === 'POST') {
            // Schedule shutdown after the response is sent so the caller
            // receives the acknowledgment before the process exits.
            setTimeout(() => {
                abortController.abort();
                Deno.exit(0);
            }, 0);

            return c.text('shutting down');
        }

        /**
         * @
         * when we run git add, the file is moved to .git/lfs/objects:
         * > large files aren't written into the repository proper,
         * >instead being stored locally at `.git/lfs/objects/{OID-PATH}`
         *  @see https://github.com/git-lfs/git-lfs/blob/release-3.0/docs/spec.md?plain=1#L133-L138
         *  as `OID[0:2]/OID[2:4]/OID`, example:
         *
         * @example .git/lfs/objects/4d/7a/4d7a214614ab2935c943f9e0ff69d22eadbb8f32b1258daaa5e2ca24d17e2393
         *
         * and the object is not pushed to lfs remotes until a git push is called
         * we run git push asynchronously, so if an image was recently uploaded,
         * that file may not be available with git
         */
        if (url.pathname.startsWith('/image/')) {
            const url = new URL(req.url);
            const oid = url.pathname.split('/')[2];

            const thumbRelPath = `thumbnails/${oid}.jpg`;
            const thumbPath = join(lib.path, thumbRelPath);
            const thumbnail: Deno.FileInfo | false = await Deno.stat(thumbPath)
                .catch(() => {
                    return false;
                });
            if (thumbnail && thumbnail.isFile) {
                let bytes = await Deno.readFile(thumbPath);

                // not a pointer, return bytes
                if (tryReadPointerSize(new TextDecoder('utf-8').decode(bytes)) === false) {
                    return c.blob(bytes, 'image/jpeg');
                }

                // if it is a pointer, check it out
                await simpleGit(lib.path).raw(['lfs', 'pull', '--include', thumbRelPath, '--exclude', '']);

                // and read again
                bytes = await Deno.readFile(thumbPath);
                return c.blob(bytes, 'image/jpeg');
            }

            const id = await store.getIdByOid(oid);
            if (!id) return c.error('could not find image by this oid');

            const im = await store.getImage(id);
            if (!im) return c.error('could not find image by this oid');

            /**  @see https://github.com/git-lfs/git-lfs/blob/release-3.0/docs/spec.md?plain=1#L133-L138 */
            // if this file does not exist, the file is definitively *not* checked out.
            const lfsPath = join(lib.path, '.git', 'lfs', 'objects', oid.slice(0, 2), oid.slice(2, 4), oid);

            await simpleGit(lib.path).raw(['lfs', 'pull', '--include', im.path, '--exclude', '']);

            const bytes = await Deno.readFile(lfsPath);

            return c.blob(bytes, im.contentType);
        }

        if (url.pathname === '/') {
            // 301?
            return Response.redirect(new URL('/gallery', url.origin), 302);
        }

        if (url.pathname === '/ingest' && req.method === 'POST') {
            const form = await req.formData();

            const file = form.get('image') as File | null;
            if (!file) {
                return c.html(
                    await render.renderToast({ message: 'Missing form field: image', variant: 'error' }),
                    400,
                );
            }

            const tagsRaw = (form.get('tags') as string) || '[]';

            const tags = await Promise.resolve(tagsRaw)
                .then((raw) => JSON.parse(raw))
                .then((parsed) => {
                    if (!Array.isArray(parsed)) return null;
                    if (!parsed.every((item) => typeof item === 'string')) return null;
                    return parsed as string[];
                })
                .catch(() => null);

            if (!tags) {
                return c.html(
                    await render.renderToast({ message: 'Tags must be a JSON array of strings', variant: 'error' }),
                    400,
                );
            }

            const name = form.get('name') as string;

            const result = await ingest(lib, store, file, tags, name)
                .catch(async (e) => {
                    if (e.cause instanceof Response) {
                        return c.html(
                            await render.renderToast({ message: e.message, variant: 'error' }),
                            502,
                        );
                    }
                    return c.html(
                        await render.renderToast({ message: e.message, variant: 'error' }),
                        400,
                    );
                });
            if (result instanceof Response) return result;

            const { event, mediaBytes, thumbnailBytes } = result;

            const appendResult = await eventLog.appendWithRollback(event, async (appendResult) => {
                // Write media and thumbnail files inside the rollback boundary.
                // If the Git commit fails, NDJSON is truncated and no files are left on disk.
                const mediaPath = join(lib.path, event.path);
                await Deno.mkdir(dirname(mediaPath), { recursive: true });
                await Deno.writeFile(mediaPath, mediaBytes);

                const thumbnailPath = join(lib.path, 'thumbnails', `${event.thumbnailOid}.jpg`);
                await Deno.mkdir(dirname(thumbnailPath), { recursive: true });
                await Deno.writeFile(thumbnailPath, thumbnailBytes);

                const paths = [appendResult.path, event.path];
                if (event.thumbnailOid) paths.push(`thumbnails/${event.thumbnailOid}.jpg`);

                await stageAndCommit(paths, `booru: add image ${event.id}`, lib)
                    .catch((err) => {
                        if (err instanceof TaskConfigurationError || err instanceof GitConstructError) {
                            // we passed invalid or malformed commands, inputs to stageAndCommit
                            throw err;
                        }
                        if (err instanceof GitError) {
                            // other errors during git commit
                            throw err;
                        }
                        throw err;
                    });
            }).catch(async (err: unknown) => {
                if (err instanceof Response) return err;
                return c.html(
                    await render.renderToast(
                        { message: `Ingest failed: ${err instanceof Error ? err.message : String(err)}`, variant: 'error' },
                    ),
                    500,
                );
            });

            if (appendResult instanceof Error) {
                return c.html(
                    await render.renderToast({ message: 'Error during event writing', variant: 'error' }),
                    500,
                );
            }
            if (appendResult instanceof Response) return appendResult;

            const applyResult = await store.applyEvent(event, appendResult.cursor)
                .catch(async () => {
                    return c.html(
                        await render.renderToast({ message: 'Could not apply event', variant: 'error' }),
                        500,
                    );
                });
            if (applyResult instanceof Response) return applyResult;

            return c.html(
                await render.renderToast({ message: 'Image uploaded', variant: 'success' }),
                201,
            );
        }

        if (url.pathname === '/regen-thumbnail') {
            debug(url);
            const id = url.searchParams.get('id') as string | null;
            if (!id) return c.error('missing parameter: id', 400);

            const image = await store.getImage(id);
            if (!image) return c.error(`Could not find image "${id}"`, 404);

            const fileExtension = image.path.split('.').pop() ?? 'jpg';
            const { oid: thumbnailOid, size: thumbnailSize, contentType } = await reloadThumbnail(
                lib,
                store,
                id,
                fileExtension,
            );

            const event: RegenThumbnailEvent = {
                op: 'regen_thumbnail',
                id: Number(id),
                thumbnailOid,
                contentType,
            };

            const appendResult = await eventLog.appendWithRollback(event, async (_appendResult) => {
                const paths = [`thumbnails/${thumbnailOid}.jpg`];
                await stageAndCommit(paths, `booru: regenerate thumbnail ${id}`, lib);
            }).catch((err: unknown) => {
                if (err instanceof Response) return err;
                return c.error(`regen-thumbnail failed: ${err instanceof Error ? err.message : String(err)}`, 500);
            });

            if (appendResult instanceof Error) return c.error('error during event writing.', 500);
            if (appendResult instanceof Response) return appendResult;

            const applyResult = await store.applyEvent(event, appendResult.cursor)
                .catch(() => c.error('ERROR: could not apply event'));
            if (applyResult instanceof Response) return applyResult;

            // TODO: maybe just send image bytes since we have them right here
            // but w/e

            // update local copy of the image, make a new card
            if (event.contentType) image.contentType = event.contentType;
            image.thumbnailOid = event.thumbnailOid;

            return c.html(await render.renderImageCard({ ...image, id: id }));
        }

        if (url.pathname === '/update-metadata' && req.method === 'POST') {
            const form = await req.formData();

            const idRaw = form.get('id');
            const nameRaw = form.get('name');

            if (typeof idRaw !== 'string') return c.error('Missing form field: id', 400);
            if (typeof nameRaw !== 'string') return c.error('Missing form field: name', 400);

            const id = Number(idRaw);
            if (!isInt(id) || id < 1) return c.error(`Invalid image id: "${idRaw}"`, 400);

            const image = await store.getImage(String(id));
            if (!image) return c.error(`Could not find image state for id "${id}"`, 404);

            const name = nameRaw.trim();
            if (name.length === 0) return c.error('Invalid image name: value is empty', 400);

            // Tags
            const tagsRaw = form.get('tags');
            if (typeof tagsRaw !== 'string') return c.error('Missing form field: tags', 400);
            const newTags = tagsRaw.trim()
                ? tagsRaw.split(/\s+/).map((t) => t.trim()).filter((t) => t.length > 0)
                : [];
            const currentSorted = [...image.tags].sort();
            const newSorted = [...newTags].sort();
            const tagsChanged =
                currentSorted.length !== newSorted.length ||
                currentSorted.some((t, i) => t !== newSorted[i]);

            // Nothing changed — return current inspector
            if (name === image.name && !tagsChanged) {
                return c.html(await render.renderInspector({ ...image, id: String(id) }));
            }

            const patch: UpdateMetadataEvent['patch'] = {};
            if (name !== image.name) patch.name = name;
            if (tagsChanged) patch.tags = newTags;

            const event: UpdateMetadataEvent = {
                op: 'update_metadata',
                id,
                patch,
            };

            const appendResult = await eventLog.appendWithRollback(event, async (appendResult) => {
                await stageAndCommit([appendResult.path], `booru: update image ${id} metadata`, lib);
            }).catch((err: unknown) => {
                if (err instanceof Response) return err;
                return c.error(`update-metadata failed: ${err instanceof Error ? err.message : String(err)}`, 500);
            });

            if (appendResult instanceof Error) return c.error('error during event writing.', 500);
            if (appendResult instanceof Response) return appendResult;

            const applyResult = await store.applyEvent(event, appendResult.cursor)
                .catch(() => c.error('ERROR: could not apply event'));
            if (applyResult instanceof Response) return applyResult;

            const updatedImage = { ...image, id: String(id) };
            if (patch.name !== undefined) updatedImage.name = patch.name;
            if (patch.tags !== undefined) updatedImage.tags = patch.tags;

            return c.html(await render.renderInspector(updatedImage));
        }

        if (url.pathname === '/delete' && req.method === 'POST') {
            const form = await req.formData();
            const idRaw = form.get('id');

            if (typeof idRaw !== 'string') return c.error('Missing form field: id', 400);

            const id = Number(idRaw);
            if (!isInt(id) || id < 1) return c.error(`Invalid image id: "${idRaw}"`, 400);

            const event: DeleteEvent = { op: 'delete', id };

            const appendResult = await eventLog.appendWithRollback(event, async (appendResult) => {
                await stageAndCommit([appendResult.path], `booru: delete image ${id}`, lib);
            }).catch((err: unknown) => {
                if (err instanceof Response) return err;
                return c.error(`delete failed: ${err instanceof Error ? err.message : String(err)}`, 500);
            });

            if (appendResult instanceof Error) return c.error('error during event writing.', 500);
            if (appendResult instanceof Response) return appendResult;

            const applyResult = await store.applyEvent(event, appendResult.cursor)
                .catch(() => c.error('ERROR: could not apply event'));
            if (applyResult instanceof Response) return applyResult;

            // TODO: invalidate gallery page cache after delete

            return c.text('ok');
        }

        if (url.pathname === '/genai/tags') {
            const id = url.searchParams.get('id');
            if (!id) return c.error('Missing parameter: id', 400);

            const image = await store.getImage(id);
            if (!image) return c.error(`Could not find image "${id}"`, 404);

            const mediaPath = join(lib.path, image.path);
            const imageBytes = await Deno.readFile(mediaPath)
                .catch((err: unknown) => {
                    console.error(`[genai] Cannot read image file: ${err instanceof Error ? err.message : String(err)}`);
                    return null;
                });
            if (!imageBytes) return c.error('Cannot read image file', 500);

            const mimeType = image.contentType || 'application/octet-stream';
            const tags = await suggestTags(imageBytes, mimeType);

            const tagBadges = tags
                .map((tag) => `<span class="text-xs font-medium px-2 py-1 rounded-full backdrop-blur-sm tag-badge">${tag}</span>`)
                .join(' ');
            return c.html(`<div class="flex flex-wrap gap-2">${tagBadges}</div>`);
        }

        if (url.pathname.startsWith('/static')) {
            return serveDir(req, {
                fsRoot: './static',
                urlRoot: 'static', // trim /static
            });
        }

        {
            const uiResponse = await handleUiRoutes(url, store, render);
            if (uiResponse) return uiResponse;
        }

        return new Response('Not Found', { status: 404 });
    };
}

export function withLogging(
    handler: (req: Request) => Promise<Response>,
): (req: Request) => Promise<Response> {
    return async (req: Request): Promise<Response> => {
        trace(() => performance.mark('req-start'));

        const response = await handler(req);

        trace(() => {
            const startTime = performance.getEntriesByName('req-start').at(-1)?.startTime || 0;
            const duration = performance.now() - startTime;
            console.log(
                `method=${req.method} path=${new URL(req.url).pathname} code=${response.status} ms=${
                    duration.toFixed(2)
                }`,
            );
            performance.clearMarks('req-start');
        });
        return response;
    };
}

// blocking
async function Start() {
    // todo: process flags
    const cfg = getFlags();

    const lib: LibConn = { path: cfg.lib };

    // idempotent
    await Init(lib.path);

    if (cfg.clearArtifacts) {
        const artifactsPath = join(lib.path, 'index', 'artifacts');

        try {
            await Deno.remove(artifactsPath, { recursive: true });
        } catch (error) {
            if (!(error instanceof Deno.errors.NotFound)) throw error;
        }
    }

    const store: DerivedIndexStore = new JsonFileIndexStore(lib);
    const eventLog: EventLog & EventLogReader = new NdjsonEventLog(lib.path);
    const render: HtmlRenderer = new CachingHtmlRenderer(lib.path);

    const needsInitialize = cfg.rebuildIndex || !(await store.isInitialized());

    // todo: end process flags

    debug(`library=${lib.path}`);

    if (cfg.rebuildIndex) console.log('Rebuilding index from committed events — this may take some time.');
    else if (needsInitialize) console.log('Initializing index from scratch — this may take some time.');
    debug(
        `needsInitialize=${needsInitialize} rebuildIndex=${cfg.rebuildIndex} IndexStoreBackend=${store.constructor.name}`,
    );

    if (needsInitialize) {
        await store.initializeEmptyIndex();
    }
    await processEvents(store, eventLog);

    if (cfg.pack) {
        console.log(`Importing Eagle pack: ${cfg.pack}`);
        const count = await ingestFromEagleSource(lib, store, eventLog, cfg.pack);
        console.log(`✅ Imported ${count} items from ${cfg.pack}`);
    }

    const abortController = new AbortController();
    const h = createHandler(store, eventLog, lib, render, abortController);

    Deno.serve({ port: cfg.port, signal: abortController.signal }, withLogging(h));
}

if (import.meta.main) {
    Start();
}
