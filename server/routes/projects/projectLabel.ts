import { agentKindForDirName, type AgentKind } from "../../../shared/session/agent-descriptors"
import { projectDirToReadableName, shortNameFromPath } from "../../lib/projectNames"

/**
 * Short, human-facing name for the project a session belongs to.
 *
 * Only Claude's dirName carries the project path, so the other agents label
 * themselves from the cwd recorded inside the transcript and disambiguate with
 * a suffix — two sessions in the same repo would otherwise look identical in
 * the sidebar. The suffix is deliberately shorter than the descriptor's product
 * name: it sits inline in a list row.
 */
const AGENT_SUFFIX: Partial<Record<AgentKind, string>> = {
  codex: "Codex",
  copilot: "Copilot",
}

export function projectLabel(dirName: string, cwd: string | null | undefined): string {
  const suffix = AGENT_SUFFIX[agentKindForDirName(dirName)]
  if (!suffix) return projectDirToReadableName(dirName).shortName
  return `${cwd ? shortNameFromPath(cwd) : suffix} (${suffix})`
}
