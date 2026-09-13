import { execFile } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { cleanupCheckout, isValidCheckoutName } from './checkout.ts';

/**
 * `POST /api/projects/create` — "Add project → New project".
 *
 * The third way to get a project, beside opening a folder that exists and
 * cloning one that exists elsewhere: starting one that does not exist yet.
 *
 * It is deliberately built on `checkout.ts`'s machinery rather than beside it,
 * because the dangerous parts are identical and must not drift:
 *
 *  - the target is `<projectsDir>/<name>` with `name` one boring path segment
 *    (`isValidCheckoutName`), so the checkout root stays a root;
 *  - the directory is created with a NON-RECURSIVE `mkdir` before anything is
 *    written, which is both the atomic existence check (EEXIST ⇒ 409, and
 *    nothing existing was touched to find out) and the proof of ownership that
 *    authorizes cleanup;
 *  - cleanup goes through `cleanupCheckout`, which refuses anything that is not
 *    a direct, non-symlinked child of the resolved root.
 *
 * The one thing this does that cloning does not is make the repo usable: a git
 * repository with no commits has no HEAD, and cezar branches a worktree off
 * HEAD for every task. Without an initial commit the project registers fine and
 * then fails on its first task with git's own words about an invalid reference,
 * which names nothing a person can act on. So the project is born with a README
 * and one commit.
 */

const run = promisify(execFile);

/** How long the git calls may take. Local disk work; a hang means something is
 *  wrong (a credential helper prompting, a filesystem stall) and a stuck
 *  request is worse than a failed one. */
const GIT_TIMEOUT_MS = 60_000;

export type CreateProjectResult =
  | { ok: true; target: string; name: string }
  | { ok: false; status: 400 | 409 | 500; error: string };

/** Injected so tests drive the git steps without a real git. */
export type GitRunner = (args: string[], cwd: string) => Promise<void>;

export const gitRunner: GitRunner = async (args, cwd) => {
  await run('git', args, {
    cwd,
    timeout: GIT_TIMEOUT_MS,
    // A new empty repo needs no credentials; a prompt here could only be
    // something going wrong, and it must fail rather than block the request.
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  });
};

export interface CreateProjectOptions {
  /** Target folder name; also the project name and the README's title. */
  name: string;
  /** The checkout root, ALREADY `~`-expanded by the caller. */
  projectsDir: string;
  /** Test seam; defaults to running the real `git`. */
  git?: GitRunner;
}

/**
 * Create an empty git project at `<projectsDir>/<name>` and answer where it is.
 *
 * Registration is the caller's job, and only on `ok: true` — the same division
 * as the checkout flow.
 */
export async function createProject(opts: CreateProjectOptions): Promise<CreateProjectResult> {
  const name = opts.name.trim();
  if (!isValidCheckoutName(name)) {
    return { ok: false, status: 400, error: `not a valid folder name: ${name.slice(0, 200)}` };
  }
  if (!opts.projectsDir.startsWith('/')) {
    return { ok: false, status: 500, error: `checkout root is not an absolute path: ${opts.projectsDir}` };
  }
  const root = resolve(opts.projectsDir);
  const target = join(root, name);

  try {
    await mkdir(root, { recursive: true });
  } catch (err) {
    return { ok: false, status: 500, error: `checkout root is not writable: ${errText(err)}` };
  }

  // The ownership token — non-recursive, so it succeeds only when it created
  // the directory itself.
  try {
    await mkdir(target);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
      return { ok: false, status: 409, error: `folder already exists: ${target}` };
    }
    return { ok: false, status: 500, error: `could not create ${target}: ${errText(err)}` };
  }

  const git = opts.git ?? gitRunner;
  try {
    // Plain `git init`: the branch comes from the operator's own
    // `init.defaultBranch`, because a project created here should look like
    // every other repo they make, not like one cezar had opinions about.
    await git(['init'], target);
    await writeFile(join(target, 'README.md'), `# ${name}\n`, 'utf8');
    await git(['add', 'README.md'], target);
    await git(['commit', '-m', 'Initial commit'], target);
  } catch (err) {
    // Cleanup first, then answer — a retry must not meet a directory that is
    // still on disk and get the 409 instead.
    await cleanupCheckout(root, target);
    // git's own words: "Please tell me who you are" for an unset identity, and
    // the hook and permission failures, all say more than a paraphrase could.
    return { ok: false, status: 500, error: gitError(err) };
  }

  return { ok: true, target, name };
}

/** git writes the useful part to stderr and exits non-zero. */
function gitError(err: unknown): string {
  const e = err as { stderr?: string; stdout?: string; message?: string };
  const detail = (e.stderr || e.stdout || '').trim();
  return detail === '' ? `git failed: ${e.message ?? String(err)}` : detail;
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
