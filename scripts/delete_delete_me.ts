const args = Deno.args[0] === '--' ? Deno.args.slice(1) : Deno.args;
const baseUrl = args[0] ?? Deno.env.get('BOORU_BASE_URL') ?? 'http://127.0.0.1:8000';
const tag = args[1] ?? 'delete-me';
const limit = 100;

let deleted = 0;

while (true) {
    const ids = await listTaggedItemIds(baseUrl, tag, limit);
    if (ids.length === 0) break;

    for (const id of ids) {
        await deleteItem(baseUrl, id);
        deleted++;
        console.log(`Deleted item ${id}`);
    }
}

console.log(`Deleted ${deleted} item${deleted === 1 ? '' : 's'} tagged #${tag}`);

async function listTaggedItemIds(baseUrl: string, tag: string, limit: number): Promise<string[]> {
    const params = new URLSearchParams({ limit: String(limit), tags: tag });
    const res = await fetch(`${baseUrl}/fragment/items?${params.toString()}`);
    const body = await res.text();

    if (res.status !== 200) {
        throw new Error(`Cannot list tagged items: expected 200, got ${res.status}: ${body}`);
    }

    return [...body.matchAll(/data-image-id="(\d+)"/g)].map((match) => match[1]);
}

async function deleteItem(baseUrl: string, id: string): Promise<void> {
    const form = new FormData();
    form.set('id', id);

    const res = await fetch(`${baseUrl}/delete`, { method: 'POST', body: form });
    const body = await res.text();

    if (res.status !== 200) {
        throw new Error(`Cannot delete item "${id}": expected 200, got ${res.status}: ${body}`);
    }
}
