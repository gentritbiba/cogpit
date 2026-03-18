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
  void config
  return ["--dangerously-skip-permissions"]
}
