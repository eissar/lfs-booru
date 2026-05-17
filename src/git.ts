import { fromFileUrl, resolve } from '@std/path';
import { GitConstructError, simpleGit } from 'simple-git';
import { debug } from '@/logging.ts';
import { panic } from '@/util.ts';

// do this in the future for the user
// const DOCUMENTS = process.env.XDG_DOCUMENTS_DIR || `${process.env.HOME}/Documents`;
// const LIBRARIES = join(DOCUMENTS, 'libraries')

// Static template path, relative to this source file.
const TEMPLATE = fromFileUrl(new URL('../libraries/template', import.meta.url));

/**
 * Idempotently initialize a booru library repo by cloning ./libraries/template.
 *
 * This intentionally does not call `git lfs ...` and does not edit .git/config.
 * `git clone` will create .git/config as normal Git repository metadata, but this
 * function does not write local Git config settings after cloning.
 */
export async function Init(repoPath: string): Promise<void> {
    // TODO: MustResolve(TEMPLATE) at startup?
    const template = await Deno.realPath(TEMPLATE).catch((e: Error) => panic(e.message));

    const repo = resolve(repoPath);

    // const stat = await Deno.stat(repo);
    // if (!stat.isDirectory) {
    //     throw new Error(`Path is not a directory: ${repo}`);
    // }
    // for await (const _dirEntry of Deno.readDir(repo)) {
    //     throw new Error(`Path must be empty`); // if there is a _dirEntry it isn't empty
    // }

    // pass deno env like?
    // .env({ ...Deno.env.toObject(), GIT_LFS_SKIP_SMUDGE: '1' })
    const failure = await simpleGit()
        .env({ GIT_LFS_SKIP_SMUDGE: '1' }) // https://github.com/git-lfs/git-lfs/blob/main/docs/man/git-lfs-faq.adoc?plain=1#L33-L35
        .clone(template, repo)
        .then(Debug)
        .then(() => null)
        .catch((e: Error) => {
            Debug(e);
            return e;
        });

    if (failure != null) {
        if (failure instanceof GitConstructError) panic(`attention: invalid application state or git not on PATH`);
        panic(`git clone failed: ${failure.message}`);
    }

    // TODO:
    // The template repo does not have an upstream remote. we set
    // a sample one here for now, but if we would like to support multiple
    // libraries in the future, it *may* be useful to have some authentication
    // by user or repository. something like that
    const gitInRepo = simpleGit(repo);
    await gitInRepo.addRemote('upstream', 'https://github.com/USER/REPO.git');

    // parse .INI at .lfsconfig for lfs.url
}

Init('/home/eissar/code/lfs-booru/libraries/new');
