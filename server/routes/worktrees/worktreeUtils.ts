import { execFileSync } from "node:child_process"
import { resolve, dirname } from "node:path"
import { readdir, open, join } from "../../helpers"

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

export async function resolveProjectPath(projectDir: string, dirName: string): Promise<string> {
  try {
    const files = await readdir(projectDir)
    for (const f of files.filter((f: string) => f.endsWith(".jsonl"))) {
      try {
        const fh = await open(join(projectDir, f), "r")
        try {
          const buf = Buffer.alloc(4096)
          const { bytesRead } = await fh.read(buf, 0, 4096, 0)
          const firstLine = buf.subarray(0, bytesRead).toString("utf-8").split("\n")[0]
          if (firstLine) {
            const parsed = JSON.parse(firstLine)
            if (parsed.cwd) {
              return parsed.cwd
            }
          }
        } finally {
          await fh.close()
        }
      } catch {
        continue
      }
    }
  } catch {
    // projectDir might not exist yet
  }
  return "/" + dirName.replace(/^-/, "").replace(/-/g, "/")
}

export function getMainWorktreeRoot(projectPath: string): string | null {
  try {
    const commonDir = execFileSync("git", ["rev-parse", "--git-common-dir"], {
      cwd: projectPath,
      encoding: "utf-8",
    }).trim()
    // --git-common-dir returns the path to the shared .git directory.
    // From main repo: ".git" (relative). From worktree: absolute or relative path to main .git.
    // Resolving it and taking dirname gives the main repo root.
    return dirname(resolve(projectPath, commonDir))
  } catch {
    return null
  }
}

export function getDefaultBranch(gitRoot: string): string {
  try {
    const ref = execFileSync("git", ["symbolic-ref", "refs/remotes/origin/HEAD"], {
      cwd: gitRoot,
      encoding: "utf-8",
    }).trim()
    return ref.replace("refs/remotes/origin/", "")
  } catch {
    return "main"
  }
}
