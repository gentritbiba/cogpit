import { resolve, dirname } from "node:path"
import { parseWorktreePath } from "../../../shared/worktreePath"
import { open } from "../../helpers"
import { runWorktreeCommand } from "./worktreeIo"

export const SESSION_HEADER_BYTES = 4096

export interface WorktreeRaw {
  /** The worktree's folder name, which is how routes address it. */
  name: string
  path: string
  head: string
  /** Empty for a detached HEAD. */
  branch: string
}

export function isValidWorktreeName(name: string): boolean {
  return /^[a-zA-Z0-9._-]+$/.test(name) && name.length <= 40
}

/**
 * The worktrees inside the project's own worktree folder, whatever their
 * branch is called: agents often rename the generated `worktree-<name>`
 * branch to a feature branch. Worktrees checked out elsewhere are not ours.
 */
export function parseWorktreeList(output: string): WorktreeRaw[] {
  const worktrees: WorktreeRaw[] = []
  let current: Partial<WorktreeRaw> = {}
  const flush = () => {
    const location = current.path ? parseWorktreePath(current.path) : null
    if (location) {
      worktrees.push({
        name: location.worktreeName,
        path: current.path!,
        head: current.head ?? "",
        branch: current.branch ?? "",
      })
    }
    current = {}
  }

  for (const line of output.split("\n")) {
    if (line.startsWith("worktree ")) {
      flush()
      current = { path: line.slice("worktree ".length) }
    } else if (line.startsWith("HEAD ")) {
      current.head = line.slice("HEAD ".length)
    } else if (line.startsWith("branch ")) {
      current.branch = line.slice("branch ".length).replace("refs/heads/", "")
    }
  }
  flush()
  return worktrees
}

export async function findWorktree(gitRoot: string, name: string): Promise<WorktreeRaw | null> {
  const output = await runWorktreeCommand("git", ["worktree", "list", "--porcelain"], { cwd: gitRoot })
  return parseWorktreeList(output).find((worktree) => worktree.name === name) ?? null
}

/** Read only the bounded JSONL header needed by worktree discovery. */
export async function readFirstJsonLine(filePath: string): Promise<Record<string, unknown> | null> {
  const fileHandle = await open(filePath, "r")
  try {
    const buffer = Buffer.alloc(SESSION_HEADER_BYTES)
    const { bytesRead } = await fileHandle.read(buffer, 0, SESSION_HEADER_BYTES, 0)
    const firstLine = buffer.subarray(0, bytesRead).toString("utf-8").split("\n", 1)[0]
    if (!firstLine) return null
    const value: unknown = JSON.parse(firstLine)
    return value && typeof value === "object" && !Array.isArray(value)
      ? value as Record<string, unknown>
      : null
  } finally {
    await fileHandle.close()
  }
}

export async function getMainWorktreeRoot(projectPath: string): Promise<string | null> {
  try {
    const commonDir = (await runWorktreeCommand("git", ["rev-parse", "--git-common-dir"], {
      cwd: projectPath,
    })).trim()
    // --git-common-dir returns the path to the shared .git directory.
    // From main repo: ".git" (relative). From worktree: absolute or relative path to main .git.
    // Resolving it and taking dirname gives the main repo root.
    return dirname(resolve(projectPath, commonDir))
  } catch {
    return null
  }
}

export async function getDefaultBranch(gitRoot: string): Promise<string> {
  try {
    const ref = (await runWorktreeCommand("git", ["symbolic-ref", "refs/remotes/origin/HEAD"], {
      cwd: gitRoot,
    })).trim()
    return ref.replace("refs/remotes/origin/", "")
  } catch {
    return "main"
  }
}
