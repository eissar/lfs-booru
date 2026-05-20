const GIT_LFS_POINTER_SPEC_VERSION = 'version https://git-lfs.github.com/spec/v1';

// assumes library image/ dir exists
// mutex for atomic writes to /image ?
export async function writePointerFile(oid: string, size: number, path: string): Promise<string> {
    const pointer = [
        GIT_LFS_POINTER_SPEC_VERSION,
        `oid sha256:${oid}`,
        `size ${size}`,
    ].join('\n');
    await Deno.writeTextFile(path, pointer);
    return path;
}
