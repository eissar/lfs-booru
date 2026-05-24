const GIT_LFS_POINTER_SPEC_VERSION = 'version https://git-lfs.github.com/spec/v1';

/**
 * Write a Git LFS pointer file at the given path.
 *
 * The pointer conforms to the Git LFS v1 spec with a `sha256` OID.
 *
 * @param oid SHA-256 hex digest of the LFS object.
 * @param size Object size in bytes.
 * @param path Destination file path for the pointer.
 * @returns The path where the pointer was written.
 */
export async function writePointerFile(oid: string, size: number, path: string): Promise<string> {
    const pointer = [
        GIT_LFS_POINTER_SPEC_VERSION,
        `oid sha256:${oid}`,
        `size ${size}`,
    ].join('\n');
    await Deno.writeTextFile(path, pointer);
    return path;
}
