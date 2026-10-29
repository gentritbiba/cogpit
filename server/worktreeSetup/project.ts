import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { realpath, stat } from "node:fs/promises"
import { isAbsolute, resolve } from "node:path"
import { RouteError, ErrorCodes } from "../lib/routeError"

const execute = promisify(execFile)
export async function gitOutput(cwd: string, args: string[], signal?: AbortSignal): Promise<string> {
  const result = await execute("git", args, { cwd, signal, encoding: "utf8", timeout: 15_000, maxBuffer: 1024 * 1024, windowsHide: true, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } })
  return result.stdout.trim()
}

export async function physicalDirectory(cwd: string): Promise<string> {
  if (!isAbsolute(cwd) || cwd.includes("\0")) throw new RouteError(400, ErrorCodes.INVALID_REQUEST, "An absolute project directory is required")
  const path = await realpath(cwd)
  if (!(await stat(path)).isDirectory()) throw new RouteError(400, ErrorCodes.INVALID_REQUEST, "Project directory does not exist")
  return path
}

/** The common Git directory identifies a project across linked and external worktrees. */
export async function projectIdentity(cwd: string): Promise<string> {
  const path = await physicalDirectory(cwd)
  const common = await gitOutput(path, ["rev-parse", "--git-common-dir"])
  return realpath(resolve(path, common))
}

export async function validateInitializedDirectory(projectCwd: string, cwd: string): Promise<string> {
  const path = await physicalDirectory(cwd)
  if (await projectIdentity(projectCwd) !== await projectIdentity(path)) {
    throw new RouteError(403, ErrorCodes.FORBIDDEN, "Initialized worktree belongs to a different project")
  }
  return path
}
