import { describe, expect, it } from "vitest"
import { nestWorktreeProjects } from "@/lib/projectWorktrees"

const project = (path: string) => ({ dirName: path.replace(/[^a-z0-9]/gi, "-"), path })

describe("nestWorktreeProjects", () => {
  it("folds worktrees under their checkout and keeps the list order", () => {
    const nested = nestWorktreeProjects([
      project("/code/app/.claude/worktrees/a"),
      project("/code/lib"),
      project("/code/app/"),
      project("/code/app/.worktrees/b"),
    ])

    expect(nested.map((entry) => [entry.path, entry.worktrees.map((wt) => wt.path)])).toEqual([
      ["/code/lib", []],
      ["/code/app/", ["/code/app/.claude/worktrees/a", "/code/app/.worktrees/b"]],
    ])
  })

  it("keeps a worktree whose checkout is not listed", () => {
    const nested = nestWorktreeProjects([project("/code/app/.claude/worktrees/a")])

    expect(nested).toEqual([{ ...project("/code/app/.claude/worktrees/a"), worktrees: [] }])
  })
})
