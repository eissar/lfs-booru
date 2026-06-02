import { serveDir } from '@std/http/file-server';
import { dirname, join } from '@std/path';
import { typeByExtension } from '@std/media-types';

import { GitConstructError, GitError, simpleGit, TaskConfigurationError } from 'simple-git';

import { getFlags } from '@/cli.ts';
import type { EventLog } from '@/event_log.ts';
import { NdjsonEventLog } from '@/event_log.ts';
import { Init, stageAndCommit } from '@/git.ts';
import { DerivedIndexStore, ItemsFilter, ItemSort, JsonFileIndexStore } from '@/index_store.ts';
import { processEvents, type RegenThumbnailEvent, type UpdateMetadataEvent } from '@/indexer.ts';
import { ingest } from '@/ingest.ts';
import { detectMediaFileExtension } from '@/ingest.ts';
import { ingestFromEagleSource } from '@/eagle-import.ts';
import { LibraryConnection as LibConn } from '@/library.ts';
import { debug, trace } from '@/logging.ts';
import { CachingHtmlRenderer, HtmlRenderer } from '@/renderer.tsx';
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
    oid: string,
    fileExtension: string,
): Promise<{ oid: string; size: number; contentType: string }> {
    // Read the original media file bytes.
    const id = await store.getIdByOid(oid);
    if (!id) throw new Error(`Could not find image id for oid "${oid}"`);

    const image = await store.getImage(String(id));
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
        const search: ItemsFilter = { limit, tags, sort };

        let itemsList;

        // if we call /gallery with an offset
        // overwrite here instead of setting search.limit
        // handle update by ref or st
        if (offset) itemsList = store.listItems({ ...search, limit: (limit + offset) });
        else itemsList = store.listItems({ ...search, limit });

        const cards = [];

        for await (const [id, img] of itemsList) {
            const image = { ...img, id: id };
            if (img.oid) cards.push(ItemCard({ image: image }));
        }

        let hasMore = true;

        // more accurately, store.listItems returns len items gt filter.limit
        // but this is the easier, stateless way to do this without refactoring
        // that function
        if (limit > cards.length) hasMore = false;

        if (offset) offset = offset + cards.length;
        else offset = cards.length;

        return c.html(
            await render.renderGalleryPage({
                filter: search,
                title: 'Gallery',
                photoGridParam: { cards, offset: String(offset), hasMore },
            }),
        );
    }

    if (url.pathname.startsWith('/fragment/inspect/')) {
        const oid = url.pathname.split('/')[3];
        const id = await store.getIdByOid(oid);
        if (!id) return c.error(`Could not find id for "${oid}"`);
        const list = store.listImagesByIds([id]);

        // just return the first
        for await (const [id, img] of list) {
            return c.html(await render.renderInspector({ ...img, id }));
        }
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

        const opts: ItemsFilter = {
            limit,
            tags,
            sort,
        };
        if (offset) opts.offset = offset;

        const itemsList = store.listItems(opts);

        const cards = [];
        for await (const [id, img] of itemsList) {
            const image = { ...img, id: id };
            if (img.oid) cards.push(ItemCard({ image: image }));
        }

        let hasMore = true;

        // more accurately, store.listItems returns len items gt filter.limit
        // but this is the easier, stateless way to do this without refactoring
        // that function
        if (limit > cards.length) hasMore = false;

        if (offset) offset = offset + cards.length;
        else offset = cards.length;

        return c.html(
            await render.renderPhotoGrid({
                cards: cards,
                offset: String(offset),
                hasMore,
            }),
        );
    }
}

function createHandler(
    store: DerivedIndexStore,
    eventLog: EventLog,
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
            if (!file) return c.error('missing form field: image', 400);

            const tagsRaw = (form.get('tags') as string) || '[]';

            const tags = await Promise.resolve(tagsRaw)
                .then((raw) => JSON.parse(raw))
                .then((parsed) => {
                    if (!Array.isArray(parsed)) return null;
                    if (!parsed.every((item) => typeof item === 'string')) return null;
                    return parsed as string[];
                })
                .catch(() => null);

            if (!tags) return c.error('tags must be a JSON array of strings', 400);

            const name = form.get('name') as string;

            const result = await ingest(lib, store, file, tags, name)
                .catch((e) => {
                    if (e.cause instanceof Response) {
                        return c.error(e.message, 502);
                    }
                    return c.error(e.message, 400);
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
            }).catch((err: unknown) => {
                if (err instanceof Response) return err;
                return c.error(`ingest failed: ${err instanceof Error ? err.message : String(err)}`, 500);
            });

            if (appendResult instanceof Error) return c.error(`error during event writing.`, 500);
            if (appendResult instanceof Response) return appendResult;

            const applyResult = await store.applyEvent(event, appendResult.cursor)
                .catch(() => {
                    return c.error('ERROR: could not apply event');
                });
            if (applyResult instanceof Response) return applyResult;

            return c.text('ok', 201);
        }

        if (url.pathname === '/regen-thumbnail') {
            debug(url);
            const oid = url.searchParams.get('oid') as string | null;
            if (!oid) return c.error('missing form field: oid', 400);

            const id = await store.getIdByOid(oid);
            if (!id) return c.error(`Could not find image id for oid "${oid}"`, 404);

            const image = await store.getImage(String(id));
            if (!image) return c.error(`Could not find image state for id "${id}"`, 404);

            const fileExtension = image.path.split('.').pop() ?? 'jpg';
            const { oid: thumbnailOid, size: thumbnailSize, contentType } = await reloadThumbnail(
                lib,
                store,
                oid,
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

            if (name === image.name) return c.html(await render.renderInspector({ ...image, id: String(id) }));

            const event: UpdateMetadataEvent = {
                op: 'update_metadata',
                id,
                patch: { name },
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

            return c.html(await render.renderInspector({ ...image, name, id: String(id) }));
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
    const eventLog: EventLog = new NdjsonEventLog(lib.path);
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
