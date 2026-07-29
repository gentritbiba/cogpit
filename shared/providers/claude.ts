import type { PermissionsConfig } from "./types"

/**
 * Encode a cwd using Claude Code's project-directory naming convention: every
 * character outside `[A-Za-z0-9]` becomes `-`, so both `/Users/x/proj` and
 * `C:\Users\x\proj` collapse into a flat directory name under
 * `~/.claude/projects`.
 */
export function encodeClaudeDirName(cwd: string): string {
  const normalized = cwd.replace(/[\\/]+$/, "") || cwd
  return normalized.replace(/[^a-zA-Z0-9]/g, "-")
}

/**
 * Best-effort inverse of {@link encodeClaudeDirName}. The encoding is lossy —
 * a literal `-` is indistinguishable from a separator — so callers that can
 * read a session's recorded `cwd` should always prefer that.
 */
export function decodeClaudeDirName(dirName: string): string {
  const windowsDrive = /^([A-Za-z])--(.*)$/.exec(dirName)
  if (windowsDrive) {
    return `${windowsDrive[1]}:\\${windowsDrive[2].replace(/-/g, "\\")}`
  }
  return "/" + dirName.replace(/^-/, "").replace(/-/g, "/")
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
