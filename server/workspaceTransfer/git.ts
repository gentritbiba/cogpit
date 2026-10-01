import { execFile as execFileCallback } from "node:child_process"
import { promisify } from "node:util"

const execFile = promisify(execFileCallback)

/** Bundling, fetching and checking out a whole repository can take minutes. */
export const GIT_TRANSFER_TIMEOUT_MS = 10 * 60_000
const GIT_DEFAULT_TIMEOUT_MS = 60_000

/** Commits Cogpit makes itself must work on a machine with no git identity. */
export const COGPIT_GIT_IDENTITY = {
  GIT_AUTHOR_NAME: "Cogpit",
  GIT_AUTHOR_EMAIL: "cogpit@localhost",
  GIT_COMMITTER_NAME: "Cogpit",
  GIT_COMMITTER_EMAIL: "cogpit@localhost",
} as const

/** Inherited variables that would point git at a repository other than `cwd`. */
const REPOSITORY_OVERRIDES = [
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GIT_COMMON_DIR",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_PREFIX",
]

export interface GitOptions {
  env?: Record<string, string>
  /** Written to stdin; stdin is closed either way. */
  input?: string
  timeout?: number
}

export class GitCommandError extends Error {
  constructor(
    readonly args: readonly string[],
    readonly stderr: string,
    readonly exitCode: number | null,
  ) {
    super(`git ${args[0]} failed${stderr ? `: ${stderr}` : ""}`)
    this.name = "GitCommandError"
  }
}

function gitEnv(overrides: Record<string, string> | undefined): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_TERMINAL_PROMPT: "0" }
  for (const name of REPOSITORY_OVERRIDES) delete env[name]
  return { ...env, ...overrides }
}

/** Run git without a shell and return stdout. Failures throw GitCommandError. */
export async function git(cwd: string, args: string[], options: GitOptions = {}): Promise<string> {
  const pending = execFile("git", args, {
    cwd,
    env: gitEnv(options.env),
    encoding: "utf-8",
    maxBuffer: 64 * 1024 * 1024,
    timeout: options.timeout ?? GIT_DEFAULT_TIMEOUT_MS,
    windowsHide: true,
  })
  pending.child.stdin?.end(options.input ?? "")
  try {
    return (await pending).stdout
  } catch (error) {
    const failure = error as NodeJS.ErrnoException & { stderr?: string; code?: number | string }
    if (failure.code === "ENOENT") throw error
    throw new GitCommandError(
      args,
      (failure.stderr ?? failure.message).trim(),
      typeof failure.code === "number" ? failure.code : null,
    )
  }
}

/** True when git exits 0; for probes like `rev-parse --verify` and `cat-file -e`. */
export async function gitSucceeds(cwd: string, args: string[]): Promise<boolean> {
  try {
    await git(cwd, args)
    return true
  } catch (error) {
    if (error instanceof GitCommandError) return false
    throw error
  }
}
