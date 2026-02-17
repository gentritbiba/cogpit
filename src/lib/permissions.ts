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
  if (config.mode === "bypassPermissions") {
    return ["--dangerously-skip-permissions"]
  }

  const args = ["--permission-mode", config.mode]

  for (const tool of config.allowedTools) {
    args.push("--allowedTools", tool)
  }

  for (const tool of config.disallowedTools) {
    args.push("--disallowedTools", tool)
  }

  return args
}
