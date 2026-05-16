import { PushImageToLFS } from './lfs.ts';

// /** @description */
type ImageState = {
    oid: string;
    path: string;
    tags: string[];
    width: number;
    height: number;
    name: string;
    mtime: string;
};

type Event = {
    op: string;
    id: number;
    path: string;
    oid: string;
    tags: string[];
    width: number;
    height: number;
    name: string;
    mtime: string;
};

export async function Index(): Promise<Response> {
    const state = JSON.parse(
        await Deno.readTextFile('index/image_state.json'),
    ) as Record<string, ImageState>;

    const images = Object.entries(state)
        .filter(([, img]) => img.oid)
        .map(([id, img]) => ({ id, ...img }));

    const html = `
    <h1>LFS Image Gallery</h1>
    <div style="display: flex; gap: 20px; flex-wrap: wrap;">
      ${
        images.map((img) => `
        <div style="border: 1px solid #ccc; padding: 10px; max-width: 350px;">
          <p><strong>${img.name}</strong></p>
          <p>Tags: ${img.tags.join(', ') || 'none'}</p>
          <p>${img.width}×${img.height}</p>
          <img src="/image/${img.oid}" style="max-width: 300px;" />
        </div>
      `).join('')
    }
    </div>
  `;
    return new Response(html, {
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
    });
}

export async function Ingest(req: Request): Promise<Response> {
    const form = await req.formData();

    const file = form.get('image') as File | null;
    if (!file) {
        return new Response(
            JSON.stringify({ error: "missing 'image' file field" }),
            { status: 400, headers: { 'Content-Type': 'application/json' } },
        );
    }

    const bytes = new Uint8Array(await file.arrayBuffer());

    const hashBuffer = await crypto.subtle.digest('SHA-256', bytes);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    const oid = hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');

    let state: Record<string, ImageState> = {};
    // TODO(later): we probably don't need to load index/image_state.json here.
    try {
        state = JSON.parse(await Deno.readTextFile('index/image_state.json'));
    } catch {
        // TODO: assert exists on server start or improve this
        //
        // no state yet, first ingestion
    }
    for (const [id, img] of Object.entries(state)) {
        if (img.oid === oid) {
            return new Response(JSON.stringify({ id: parseInt(id) }), {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
            });
        }
    }

    const size = bytes.byteLength;

    const ids = Object.keys(state).map(Number);
    const nextId = ids.length > 0 ? Math.max(...ids) + 1 : 1;

    const name = (form.get('name') as string) || `Image ${nextId}`;
    const tagsRaw = (form.get('tags') as string) || '[]';
    let tags: string[];
    try {
        tags = JSON.parse(tagsRaw);
        if (!Array.isArray(tags)) throw new Error();
    } catch {
        return new Response(
            JSON.stringify({ error: 'tags must be a JSON array string' }),
            { status: 400, headers: { 'Content-Type': 'application/json' } },
        );
    }
    const height = parseInt((form.get('height') as string) || '0') || 0;
    const width = parseInt((form.get('width') as string) || '0') || 0;
    const mtime = (form.get('mtime') as string) || new Date().toISOString();

    const event: Event = {
        op: 'add',
        id: nextId,
        path: `images/${nextId}.png`,
        oid,
        tags,
        width,
        height,
        name,
        mtime,
    };

    const pointer = `version https://git-lfs.github.com/spec/v1\noid sha256:${oid}\nsize ${size}\n`;

    const eventLogPath = 'events/2026-05.ndjson';

    await Deno.mkdir('images').catch(() => {}); // directory exists
    await Deno.writeTextFile(event.path, pointer);

    const lfsRes = await PushImageToLFS(oid, bytes);
    if (!lfsRes.ok) {
        return new Response(
            JSON.stringify({ error: `LFS push failed: ${lfsRes.status}` }),
            { status: 502, headers: { 'Content-Type': 'application/json' } },
        );
    }

    // Optional for later:
    // const cmd = new Deno.Command('deno', {
    //     args: ['run', '--allow-read', '--allow-write', 'indexer.ts'],
    // });
    // const { success, stderr } = cmd.outputSync();
    // if (!success) {
    //     return new Response(
    //         JSON.stringify({
    //             error: `indexer failed: ${new TextDecoder().decode(stderr)}`,
    //         }),
    //         { status: 500, headers: { 'Content-Type': 'application/json' } },
    //     );
    // }

    await Deno.mkdir('events').catch(() => {}); // directory exists
    await Deno.writeTextFile(
        eventLogPath,
        JSON.stringify(event) + '\n',
        { append: true, create: true },
    );

    const gitAdd = await new Deno.Command('git', {
        args: ['add', '--', event.path, eventLogPath],
    }).output();
    if (!gitAdd.success) {
        return new Response(
            JSON.stringify({
                error: `git add failed: ${new TextDecoder().decode(gitAdd.stderr)}`,
            }),
            { status: 500, headers: { 'Content-Type': 'application/json' } },
        );
    }

    const gitCommit = await new Deno.Command('git', {
        args: [
            'commit',
            '-m',
            `ingest: add image ${nextId}`,
            '--',
            event.path,
            eventLogPath,
        ],
    }).output();
    if (!gitCommit.success) {
        return new Response(
            JSON.stringify({
                error: `git commit failed: ${new TextDecoder().decode(gitCommit.stderr)}`,
            }),
            { status: 500, headers: { 'Content-Type': 'application/json' } },
        );
    }

    return new Response(JSON.stringify({ id: nextId }), {
        status: 201,
        headers: { 'Content-Type': 'application/json' },
    });
}
