// @vitest-environment node
import { homedir } from "node:os"
import { describe, expect, it } from "vitest"
import { descriptorFor } from "../../../shared/session/agent-descriptors"
import { projectLabel } from "../../routes/projects/projectLabel"

const home = homedir()
const claudeDirName = (cwd: string) => descriptorFor("claude").dirName.encode(cwd)
const codexDirName = (cwd: string) => descriptorFor("codex").dirName.encode(cwd)

describe("projectLabel", () => {
  it("names a worktree after its checkout, then the worktree", () => {
    const cwd = `${home}/code/honest-cms/.claude/worktrees/inventory-admin`

    expect(projectLabel(claudeDirName(cwd), cwd)).toBe("honest-cms › inventory-admin")
  })

  it("keeps the agent suffix for a worktree of a path-less agent", () => {
    const cwd = "/work/app/.worktrees/fix"

    expect(projectLabel(codexDirName(cwd), cwd)).toBe("app › fix (Codex)")
  })

  it("labels a checkout as before", () => {
    expect(projectLabel(claudeDirName(`${home}/code/honest-cms`), `${home}/code/honest-cms`)).toBe("honest-cms")
  })
})
