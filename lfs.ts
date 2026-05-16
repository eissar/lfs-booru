import { c } from './c.ts';

const LFS_SERVER = 'http://localhost:8080';
const LFS_AUTH = btoa('user:pass');

export type LFSUpload = {
    href: string;
    header?: Record<string, string>;
};

export type LFSObject = {
    actions?: {
        upload?: LFSUpload;
    };
};

export async function FetchImageFromLFS(oid: string): Promise<Response> {
    const res = await fetch(`${LFS_SERVER}/objects/${oid}`, {
        headers: {
            Authorization: `Basic ${LFS_AUTH}`,
            Accept: 'application/vnd.git-lfs',
        },
    });
    return new Response(res.body, {
        headers: { 'Content-Type': 'image/png' },
    });
}

export async function PushImageToLFS(
    oid: string,
    bytes: Uint8Array,
): Promise<Response> {
    // Response or Error
    const batchRes: LFSObject[] | Error = await fetch(
        `${LFS_SERVER}/objects/batch`,
        {
            method: 'POST',
            headers: {
                Authorization: `Basic ${LFS_AUTH}`,
                'Content-Type': 'application/vnd.git-lfs+json',
                Accept: 'application/vnd.git-lfs+json',
            },
            body: JSON.stringify({
                operation: 'upload',
                transfers: ['basic'],
                objects: [{ oid, size: bytes.byteLength }],
            }),
        },
    ).then((res) => {
        if (!res.ok) throw new Error(`LFS batch request failed: ${res.status}`);
        return res;
    }).then(async (res) => {
        const batch = await res.json() as { objects: LFSObject[] };
        return batch.objects ?? [];
    });

    if (batchRes instanceof Error) return c.error(batchRes.message, 502);

    const upload: LFSUpload | undefined = batchRes[0]?.actions?.upload;

    if (!upload?.href) {
        // TODO: verify
        //
        // Object already exists on LFS server — not an error
        return new Response(null, { status: 200 });
    }

    return await fetch(upload.href, {
        method: 'PUT',
        headers: {
            Authorization: `Basic ${LFS_AUTH}`,
            'Content-Type': 'application/octet-stream',
            ...(upload.header || {}),
        },
        // TODO: check memory/ image serving
        body: new Blob([new Uint8Array(bytes)]),
    });
}
