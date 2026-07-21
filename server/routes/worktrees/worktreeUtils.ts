import { resolve, dirname } from "node:path"
import { readdir, open, join } from "../../helpers"
import {
  mapWithConcurrency,
  runWorktreeCommand,
  SESSION_HEADER_CONCURRENCY,
} from "./worktreeIo"

export const SESSION_HEADER_BYTES = 4096

export interface WorktreeRaw {
  path: string
  head: string
  branch: string
}

export function isValidWorktreeName(name: string): boolean {
  return /^[a-zA-Z0-9._-]+$/.test(name) && name.length <= 40
}

export function parseWorktreeList(output: string): WorktreeRaw[] {
  const worktrees: WorktreeRaw[] = []
  let current: Partial<WorktreeRaw> = {}

  for (const line of output.split("\n")) {
    if (line.startsWith("worktree ")) {
      current = { path: line.slice("worktree ".length) }
    } else if (line.startsWith("HEAD ")) {
      current.head = line.slice("HEAD ".length)
    } else if (line.startsWith("branch ")) {
      current.branch = line.slice("branch ".length).replace("refs/heads/", "")
    } else if (line === "" && current.path) {
      if (current.branch?.startsWith("worktree-")) {
        worktrees.push(current as WorktreeRaw)
      }
      current = {}
    }
  }
  return worktrees
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

export async function resolveProjectPath(projectDir: string, dirName: string): Promise<string> {
  try {
    const files = await readdir(projectDir)
    const sessionFiles = files.filter((file: string) => file.endsWith(".jsonl"))
    const headers = await mapWithConcurrency(
      sessionFiles,
      SESSION_HEADER_CONCURRENCY,
      async (file) => {
        try {
          return await readFirstJsonLine(join(projectDir, file))
        } catch {
          return null
        }
      },
    )

    for (const header of headers) {
      if (typeof header?.cwd === "string" && header.cwd) return header.cwd
    }
  } catch {
    // projectDir might not exist yet
  }
  return "/" + dirName.replace(/^-/, "").replace(/-/g, "/")
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
