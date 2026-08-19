import { execFile as execFileCallback } from "node:child_process"
import { realpath, stat } from "node:fs/promises"
import { isAbsolute, resolve } from "node:path"
import { promisify } from "node:util"

const execFile = promisify(execFileCallback)

export type GitProject =
  | {
    ok: true
    /** Canonical path of the requested cwd. */
    projectPath: string
    /** Repository root, or null when the cwd is not inside a repository. */
    root: string | null
  }
  | { ok: false; status: number; error: string }

export function runGit(cwd: string, args: string[]) {
  return execFile("git", args, {
    cwd,
    encoding: "utf-8",
    maxBuffer: 8 * 1024 * 1024,
    timeout: 10_000,
    windowsHide: true,
  })
}

/**
 * Canonicalize a request cwd and locate the repository that contains it.
 * Callers decide what a missing repository means, so that case succeeds with a
 * null root rather than failing.
 */
export async function resolveGitProject(cwd: string): Promise<GitProject> {
  if (!isAbsolute(cwd)) return { ok: false, status: 400, error: "cwd must be an absolute path" }

  let projectPath: string
  try {
    projectPath = await realpath(resolve(cwd))
    if (!(await stat(projectPath)).isDirectory()) {
      return { ok: false, status: 400, error: "cwd must be a directory" }
    }
  } catch {
    return { ok: false, status: 404, error: "Project directory not found" }
  }

  try {
    const result = await runGit(projectPath, ["rev-parse", "--show-toplevel"])
    return { ok: true, projectPath, root: await realpath(result.stdout.trim()) }
  } catch (error) {
    const candidate = error as NodeJS.ErrnoException & { stderr?: string }
    if (candidate.code === "ENOENT") {
      return { ok: false, status: 503, error: "Git is not installed or not available in PATH" }
    }
    if (/not a git repository/i.test(candidate.stderr ?? candidate.message)) {
      return { ok: true, projectPath, root: null }
    }
    return { ok: false, status: 500, error: "Unable to read the git repository" }
  }
}
