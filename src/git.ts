import { fromFileUrl, join, resolve } from '@std/path';
import { simpleGit } from 'simple-git';
import { debug } from '@/logging.ts';
import { panic } from '@/util.ts';
import { LibraryConnection as LibraryConn } from './library.ts';

// do this in the future for the user
// const DOCUMENTS = process.env.XDG_DOCUMENTS_DIR || `${process.env.HOME}/Documents`;
// const LIBRARIES = join(DOCUMENTS, 'libraries')

// Static template path, relative to this source file.
const TEMPLATE = fromFileUrl(new URL('../libraries/template', import.meta.url));

/**
 * Idempotently initialize a booru library repo by cloning ./libraries/template.
 *
 * @panics if TEMPLATE cannot be resolved
 * @returns `null` on success, or `Error` when clone fails.
 * @throws Error, GitError, GitConstructError from simpleGit
 *
 * This intentionally does not call `git lfs ...` and does not edit .git/config.
 * `git clone` will create .git/config as normal Git repository metadata, but this
 * function does not write local Git config settings after cloning.
 */
export async function Init(repoPath: string): Promise<null | Error> {
    // TODO: MustResolve(TEMPLATE) at startup?
    const template = await Deno.realPath(TEMPLATE).catch((e: Error) => panic(e.message));

    const repo = resolve(repoPath);

    // pass deno env like?
    // .env({ ...Deno.env.toObject(), GIT_LFS_SKIP_SMUDGE: '1' })
    const failure = await simpleGit()
        .env({ GIT_LFS_SKIP_SMUDGE: '1' }) // https://github.com/git-lfs/git-lfs/blob/main/docs/man/git-lfs-faq.adoc?plain=1#L33-L35
        .clone(template, repo)
        .then(debug)
        .then(() => null)
        .catch((e) => {
            debug(e);
            return e;
        });

    if (failure != null) {
        return failure;
    }

    // set skip smudge for future ops
    const cfg = join(repo, '.git', 'config');
    await Deno.writeTextFile(cfg, '\n[lfs]\n\tskipSmudge = true\n', { append: true })
        .catch((e) => {
            debug(e);
            return e;
        });

    debug(() => Deno.readTextFileSync(cfg));

    // TODO:
    // The template repo does not have an upstream remote. we set
    // a sample one here for now, but if we would like to support multiple
    // libraries in the future, it *may* be useful to have some authentication
    // by user or repository. something like that
    const gitInRepo = simpleGit(repo);
    await gitInRepo.addRemote('upstream', 'https://github.com/USER/REPO.git');

    // parse .INI at .lfsconfig -> assert lfs.url
    // parse gitconfig -> assert lfs.skipSmudge
    return null;
}

/**
 * Stage the given paths and create a commit in the library repository.
 *
 * @param paths File paths to stage, relative to or absolute within the library.
 * @param message Commit message.
 * @param lib Library connection descriptor.
 * @returns Resolves after the commit is created.
 * @throws GitConstructError, GitError, GitPluginError, GitResponseError, TaskConfigurationError
 * bubbling from any error from add / commit
 */
export async function stageAndCommit(
    paths: string[],
    message: string,
    lib: LibraryConn,
): Promise<void> {
    const git = simpleGit(lib.path);

    await git.add(paths)
        .then((result) => debug(result));

    await git.commit(message, paths)
        .then((result) => debug(result));
}
