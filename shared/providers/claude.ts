import type { PermissionsConfig } from "./types"

/** Encode a cwd using Claude Code's project-directory naming convention. */
export function encodeClaudeDirName(cwd: string): string {
  const normalized = cwd.replace(/[\\/]+$/, "") || cwd
  return normalized.replace(/[:\\/]/g, "-")
}

export function buildClaudePermArgs(permissions?: PermissionsConfig): string[] {
  if (!permissions || !permissions.mode) {
    return ["--permission-mode", "default"]
  }
  if (permissions.mode === "bypassPermissions") {
    return ["--dangerously-skip-permissions"]
  }

  const args: string[] = []
  const modeMap: Record<string, string> = {
    default: "default",
    plan: "plan",
    acceptEdits: "acceptEdits",
    dontAsk: "dontAsk",
    auto: "auto",
  }
  const mapped = modeMap[permissions.mode]
  if (mapped) {
    args.push("--permission-mode", mapped)
  }

  if (permissions.allowedTools) {
    for (const tool of permissions.allowedTools) {
      args.push("--allowedTools", tool)
    }
  }

  if (permissions.disallowedTools) {
    for (const tool of permissions.disallowedTools) {
      args.push("--disallowedTools", tool)
    }
  }

  return args
}

export function buildClaudeModelArgs(model?: string): string[] {
  return model ? ["--model", model] : []
}

export function buildClaudeEffortArgs(effort?: string): string[] {
  return effort ? ["--effort", effort] : []
}
