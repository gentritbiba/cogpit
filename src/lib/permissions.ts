export type PermissionMode =
  | "bypassPermissions"
  | "default"
  | "plan"
  | "acceptEdits"
  | "dontAsk"
  | "delegate"

export interface PermissionsConfig {
  mode: PermissionMode
  allowedTools: string[]
  disallowedTools: string[]
}

export const DEFAULT_PERMISSIONS: PermissionsConfig = {
  mode: "bypassPermissions",
  allowedTools: [],
  disallowedTools: [],
}

export const KNOWN_TOOLS = [
  "Bash",
  "Read",
  "Write",
  "Edit",
  "Glob",
  "Grep",
  "WebFetch",
  "WebSearch",
  "NotebookEdit",
  "Task",
] as const

export const PERMISSIONS_STORAGE_KEY = "cogpit:permissions"

export function buildPermissionArgs(config: PermissionsConfig): string[] {
  if (!config.mode || config.mode === "bypassPermissions") {
    return ["--dangerously-skip-permissions"]
  }

  const args: string[] = []

  const modeMap: Record<string, string> = {
    default: "default",
    plan: "plan",
    acceptEdits: "acceptEdits",
    dontAsk: "dontAsk",
  }
  const mapped = modeMap[config.mode]
  if (mapped) {
    args.push("--permission-mode", mapped)
  }

  for (const tool of config.allowedTools) {
    args.push("--allowedTools", tool)
  }

  for (const tool of config.disallowedTools) {
    args.push("--disallowedTools", tool)
  }

  return args
}
