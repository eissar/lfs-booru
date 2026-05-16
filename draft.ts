import {
    dirname,
    fromFileUrl,
    resolve,
} from 'https://deno.land/std@0.190.0/path/mod.ts';

// Static template path, relative to this source file.
const TEMPLATE = fromFileUrl(new URL('./libraries/template', import.meta.url));

class InitError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'InitError';
    }
}

async function pathExists(path: string): Promise<boolean> {
    try {
        await Deno.stat(path);
        return true;
    } catch (err) {
        if (err instanceof Deno.errors.NotFound) return false;
        throw err;
    }
}

async function isEmptyDir(path: string): Promise<boolean> {
    for await (const _entry of Deno.readDir(path)) {
        return false;
    }
    return true;
}

async function git(args: string[], opts: {
    cwd?: string;
    env?: Record<string, string>;
} = {}): Promise<string> {
    const out = await new Deno.Command('git', {
        args,
        cwd: opts.cwd,
        env: opts.env,
        stdout: 'piped',
        stderr: 'piped',
    }).output();

    const stdout = new TextDecoder().decode(out.stdout);
    const stderr = new TextDecoder().decode(out.stderr);

    if (!out.success) {
        throw new InitError(`git ${args.join(' ')} failed\n${stderr}`);
    }

    return stdout;
}

async function isGitWorkTree(path: string): Promise<boolean> {
    try {
        const out = await git(['rev-parse', '--is-inside-work-tree'], { cwd: path });
        return out.trim() === 'true';
    } catch {
        return false;
    }
}

async function gitConfigFromFile(
    repo: string,
    configFile: string,
    key: string,
): Promise<string | null> {
    const out = await new Deno.Command('git', {
        args: ['config', '--file', configFile, '--get', key],
        cwd: repo,
        stdout: 'piped',
        stderr: 'piped',
    }).output();

    if (!out.success) return null;
    return new TextDecoder().decode(out.stdout).trim();
}

async function assertPathExists(repo: string, relativePath: string): Promise<void> {
    if (!await pathExists(`${repo}/${relativePath}`)) {
        throw new InitError(`library repo is missing required path: ${relativePath}`);
    }
}

async function assertLibraryRepo(repo: string): Promise<void> {
    if (!await isGitWorkTree(repo)) {
        throw new InitError(`library path is not a git work tree: ${repo}`);
    }

    await assertPathExists(repo, '.gitattributes');
    await assertPathExists(repo, '.lfsconfig');
    await assertPathExists(repo, 'images');
    await assertPathExists(repo, 'events');
    await assertPathExists(repo, 'index');

    // Do not use the git-lfs CLI here. We only read the tracked .lfsconfig.
    const lfsUrl = await gitConfigFromFile(repo, '.lfsconfig', 'lfs.url');
    if (!lfsUrl) {
        throw new InitError('library .lfsconfig must define lfs.url');
    }

    const fetchExclude = await gitConfigFromFile(repo, '.lfsconfig', 'lfs.fetchexclude');
    if (fetchExclude !== '*') {
        throw new InitError("library .lfsconfig must define lfs.fetchexclude = '*'");
    }
}

/**
 * Idempotently initialize a booru library repo by cloning ./libraries/template.
 *
 * This intentionally does not call `git lfs ...` and does not edit .git/config.
 * `git clone` will create .git/config as normal Git repository metadata, but this
 * function does not write local Git config settings after cloning.
 */
export async function Init(pathToRepo: string): Promise<void> {
    const template = await Deno.realPath(TEMPLATE);
    const repo = resolve(pathToRepo);

    if (!await isGitWorkTree(template)) {
        throw new InitError(`template path is not a git work tree: ${template}`);
    }

    if (await pathExists(repo)) {
        const stat = await Deno.stat(repo);
        if (!stat.isDirectory) {
            throw new InitError(`library path exists but is not a directory: ${repo}`);
        }

        if (await isGitWorkTree(repo)) {
            await assertLibraryRepo(repo);
            return;
        }

        if (!await isEmptyDir(repo)) {
            throw new InitError(
                `library path exists, is non-empty, and is not a git repo: ${repo}`,
            );
        }
    } else {
        await Deno.mkdir(dirname(repo), { recursive: true });
    }

    // Avoid hydrating any LFS objects during clone. The tracked .lfsconfig also
    // has lfs.fetchexclude = *, which controls later fetch/pull behavior without
    // requiring a local .git/config write.
    await git(['clone', '--', template, repo], {
        env: { GIT_LFS_SKIP_SMUDGE: '1' },
    });

    await assertLibraryRepo(repo);
}
