import { agentKindForDirName, descriptorForDirName, type AgentKind } from "../../../shared/session/agent-descriptors"
import { parseWorktreePath } from "../../../shared/worktreePath"
import { projectDirToReadableName, shortNameFromPath } from "../../lib/projectNames"

/**
 * Short, human-facing name for the project a session belongs to.
 *
 * Only Claude's dirName carries the project path, so the other agents label
 * themselves from the cwd recorded inside the transcript and disambiguate with
 * a suffix — two sessions in the same repo would otherwise look identical in
 * the sidebar. The suffix is deliberately shorter than the descriptor's product
 * name: it sits inline in a list row. A worktree is named after the checkout
 * it was cut from, followed by its own name.
 */
const AGENT_SUFFIX: Partial<Record<AgentKind, string>> = {
  codex: "Codex",
  copilot: "Copilot",
}

export function projectLabel(dirName: string, cwd: string | null | undefined): string {
  const worktree = cwd ? parseWorktreePath(cwd) : null
  const worktreeSuffix = worktree ? ` › ${worktree.worktreeName}` : ""
  const suffix = AGENT_SUFFIX[agentKindForDirName(dirName)]
  if (!suffix) {
    const projectDir = worktree ? descriptorForDirName(dirName).dirName.encode(worktree.parentPath) : dirName
    return projectDirToReadableName(projectDir).shortName + worktreeSuffix
  }
  const projectPath = worktree?.parentPath ?? cwd
  return `${projectPath ? shortNameFromPath(projectPath) + worktreeSuffix : suffix} (${suffix})`
}
