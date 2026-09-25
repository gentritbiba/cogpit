import { parseWorktreePath } from "@/lib/format"

type WithWorktrees<T> = T & { worktrees: T[] }

function normalizePath(path: string): string {
  return path.replace(/[\\/]+$/, "") || path
}

/**
 * Worktree projects folded under the checkout they were cut from, so a list
 * of projects shows each repository once. Order is kept, and a worktree whose
 * checkout is not listed stays top-level rather than disappearing.
 */
export function nestWorktreeProjects<T extends { path: string }>(projects: readonly T[]): Array<WithWorktrees<T>> {
  const entries = projects.map((project): WithWorktrees<T> => ({ ...project, worktrees: [] }))
  const parents = new Map<string, WithWorktrees<T>>()
  for (const entry of entries) {
    const key = normalizePath(entry.path)
    if (!parseWorktreePath(entry.path) && !parents.has(key)) parents.set(key, entry)
  }
  return entries.filter((entry, index) => {
    const worktree = parseWorktreePath(entry.path)
    const parent = worktree && parents.get(normalizePath(worktree.parentPath))
    if (!parent) return true
    parent.worktrees.push(projects[index])
    return false
  })
}
