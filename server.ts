import { serveDir } from '@std/http/file-server';

import { GitConstructError, GitError, TaskConfigurationError } from 'simple-git';

import { getFlags } from '@/cli.ts';
import type { EventLog } from '@/event_log.ts';
import { NdjsonEventLog } from '@/event_log.ts';
import { Init, stageAndCommit } from '@/git.ts';
import { DerivedIndexStore, ItemsFilter, ItemSort, JsonFileIndexStore } from '@/index_store.ts';
import { AddEvent, processEvents } from '@/indexer.ts';
import { ingest } from '@/ingest.ts';
import { GetObjectContent, LfsConnection as LfsConn } from '@/lfs/api.ts';
import { LibraryConnection as LibConn } from '@/library.ts';
import { debug, trace } from '@/logging.ts';
import { CachingHtmlRenderer, HtmlRenderer } from '@/renderer.ts';
import { c, isInt } from '@/util.ts';

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

        const tags = url.searchParams.getAll('tags')
            .flatMap((value) => value.split(','))
            .map((tag) => tag.trim())
            .filter((tag) => tag.length > 0);

        let sort: ItemSort = itemSortParameterMap['idDesc'];
        if (url.searchParams.has('sort')) {
            const match = itemSortParameterMap[url.searchParams.get('sort') ?? ''];
            if (match !== undefined) sort = match;
        }
        return c.html(
            await render.renderGalleryPage({
                filter: { limit, tags, sort },
                title: 'Gallery',
            }),
        );
    }

    if (url.pathname.startsWith('/fragment/inspect/')) {
        const oid = url.pathname.split('/')[3];
        const id = await store.getIdByOid(oid);
        if (!id) return c.error(`Could not find id for "${oid}"`);
        const list = store.listImagesByIds([id]);

        // just return the first
        for await (const [_id, img] of list) {
            return c.html(await render.renderInspector(img));
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

        const imageList = store.listItems(opts);

        const images = [];
        for await (const [id, img] of imageList) {
            if (img.oid) images.push({ id, ...img });
        }
        const cards = await Promise.all(images.map((img) => render.renderImageCard(img)));
        const rendered = cards.length;

        let hasMore = true;

        // more accurately, store.listItems returns len items gt filter.limit
        // but this is the easier, stateless way to do this without refactoring
        // that function
        if (limit > rendered) hasMore = false;
        debug([limit, rendered, limit > rendered]);
        debug(hasMore);

        if (offset) offset = offset + images.length;
        else offset = images.length;

        return c.html(
            await render.renderPhotoGrid({
                cards: cards.join(''),
                offset: String(offset),
                hasMore,
            }),
        );
    }
}

function createHandler(
    store: DerivedIndexStore,
    eventLog: EventLog,
    conn: LfsConn,
    lib: LibConn,
    render: HtmlRenderer,
): (req: Request) => Promise<Response> {
    return async (req: Request): Promise<Response> => {
        const url = new URL(req.url);

        console.log(
            `[request] method=${req.method} path=${url.pathname} query=${url.search}`,
        );

        if (url.pathname.startsWith('/image/')) {
            const url = new URL(req.url);
            const oid = url.pathname.split('/')[2];
            return await GetObjectContent(conn, oid);
        }

        if (url.pathname === '/') {
            // 301?
            return Response.redirect(new URL('/gallery', url.origin), 302);
        }

        if (url.pathname === '/ingest' && req.method === 'POST') {
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

            const event: AddEvent | Response = await ingest(lib, conn, store, file, tags, name)
                .catch((e) => {
                    if (e.cause instanceof Response) {
                        // upstream error
                        // we can match url, path here if we want later.
                        // if (new URL(e.cause.url).origin === conn.url)
                        //
                        // for now only upstream with cause:response is lfs-server
                        // errors
                        return c.error(e.message, 502);
                    }
                    return c.error(e.message, 400);
                });
            if (event instanceof Response) return event; // error

            const appendResult = await eventLog.appendWithRollback(event, async (appendResult) => {
                // pass relative file paths
                await stageAndCommit([appendResult.path, event.path], `booru: add image ${event.id}`, lib)
                    .catch((err) => {
                        if (err instanceof TaskConfigurationError || err instanceof GitConstructError) {
                            // we passed invalid or malformed commands, inputs to stageAndCommit
                            throw err;
                        }
                        if (err instanceof GitError) { // also GitResponseError
                            // other errors during git commit
                            throw err;
                        }
                        throw err;
                    });
            }).catch((err: unknown) => {
                if (err instanceof Response) return err; // when does this happen?
                return c.error(`ingest failed: ${err instanceof Error ? err.message : String(err)}`, 500);
            });

            // we can make this more specific
            if (appendResult instanceof Error) return c.error(`error during event writing.`, 500);
            if (appendResult instanceof Response) return appendResult; // when does this happen?

            // apply after everything happened without err
            const applyResult = await store.applyEvent(event, appendResult.cursor)
                .catch(() => {
                    return c.error('ERROR: could not apply event');
                });
            if (applyResult instanceof Response) return applyResult;

            return c.text('ok', 201);
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

    const conn: LfsConn = {
        url: cfg.lfsserver,
        auth: cfg.lfsauth,
        user: 'USER',
        repo: 'REPO',
    };

    const lib: LibConn = { path: cfg.lib };

    // idempotent
    await Init(lib.path);

    const store: DerivedIndexStore = new JsonFileIndexStore(lib);
    const eventLog: EventLog = new NdjsonEventLog(lib.path);
    const render: HtmlRenderer = new CachingHtmlRenderer(lib.path);

    const indexFlag = !(await store.isInitialized());

    // todo: end process flags

    debug(`library=${lib.path} LFS_SERVER=${cfg.lfsserver}`);

    // TODO:
    // if (indexFlag) console.log('Attempting re-index from last checkpoint')
    if (indexFlag) console.log('Initializing index from scratch — this may take some time.');
    debug(`indexFlag=${indexFlag} IndexStoreBackend=${store.constructor.name}`);

    if (!(await store.isInitialized())) {
        await store.initializeEmptyIndex();
        await processEvents(store, eventLog);
    }

    const h = createHandler(store, eventLog, conn, lib, render);

    Deno.serve({ port: cfg.port }, withLogging(h));
}

if (import.meta.main) {
    Start();
}
