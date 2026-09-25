import { allDescriptors } from "./session/agent-descriptors"

export interface WorktreeLocation {
  /** The checkout the worktree was cut from. */
  parentPath: string
  worktreeName: string
}

/** A folder name as a pattern matching either path separator. */
function folderPattern(folder: string): string {
  return folder.split("/").map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("[\\\\/]")
}

/** Each CLI's own worktree folder, then the older `.worktrees` layout. */
const WORKTREE_SEGMENT = new RegExp(
  `[\\\\/](?:${[...allDescriptors().map((d) => d.projectWorktreeDir), ".worktrees"]
    .filter((folder): folder is string => folder !== null)
    .map(folderPattern)
    .join("|")})[\\\\/]([^\\\\/]+)`,
)

/** If a path is inside a project's worktree folder, the project it belongs to and the worktree's name. */
export function parseWorktreePath(fullPath: string): WorktreeLocation | null {
  const match = WORKTREE_SEGMENT.exec(fullPath)
  if (!match) return null
  return { parentPath: fullPath.slice(0, match.index), worktreeName: match[1] }
}

/** The branch generated along with a worktree, which is removed with it; a branch someone named is kept. */
export function isGeneratedWorktreeBranch(worktreeName: string, branch: string): boolean {
  return branch === `worktree-${worktreeName}`
}
