import { serveDir } from '@std/http/file-server';

import { GitConstructError, GitError, TaskConfigurationError } from 'simple-git';

import { getFlags } from '@/cli.ts';
import type { EventLog } from '@/event_log.ts';
import { NdjsonEventLog } from '@/event_log.ts';
import { Init, stageAndCommit } from '@/git.ts';
import { DerivedIndexStore, JsonFileIndexStore } from '@/index_store.ts';
import { AddEvent, processEvents } from '@/indexer.ts';
import { ingest } from '@/ingest.ts';
import { GetObjectContent, LfsConnection as LfsConn } from '@/lfs/api.ts';
import { LibraryConnection as LibConn } from '@/library.ts';
import { debug, trace } from '@/logging.ts';
import { CachingHtmlRenderer, HtmlRenderer } from '@/renderer.ts';
import { c, isInt } from '@/util.ts';

async function handleUiRoutes(url: URL, store: DerivedIndexStore, render: HtmlRenderer): Promise<void | Response> {
    if (url.pathname === '/gallery') {
        return c.html(await render.renderGalleryPage({ title: 'Gallery' }));
    }

    if (url.pathname === '/fragment/items') {
        const MIN_LIMIT = 10;
        let limit = Number(url.searchParams.get('limit'));
        if (!isInt(limit) || limit < MIN_LIMIT) limit = MIN_LIMIT;

        const tags = url.searchParams.getAll('tags')
            .flatMap((value) => value.split(','))
            .map((tag) => tag.trim())
            .filter((tag) => tag.length > 0);

        const imageList = store.listItems({
            limit,
            tags,
        });

        const images = [];
        for await (const [id, img] of imageList) {
            if (img.oid) images.push({ id, ...img });
        }
        const cards = await Promise.all(images.map((img) => render.renderImageCard(img)));

        return c.html(await render.renderPhotoGrid({ cards: cards.join('') }));
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
async function Start(port: number = 8000) {
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

    Deno.serve({ port }, withLogging(h));
}

if (import.meta.main) {
    Start();
}
