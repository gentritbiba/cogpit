import type { PermissionsConfig as AgentPermissionsConfig } from "../../shared/session/agent-descriptors"

export type PermissionMode =
  | "bypassPermissions"
  | "default"
  | "plan"
  | "acceptEdits"
  | "dontAsk"
  | "auto"
  | "delegate"

/**
 * The access picker's value on this device. It is the wire contract every agent
 * reads (`AgentDescriptor.launchArgs.permissions`) with the fields pinned down:
 * the renderer always has all three, because it writes them itself.
 */
export interface PermissionsConfig extends AgentPermissionsConfig {
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
  "Agent",
] as const

export const PERMISSIONS_STORAGE_KEY = "cogpit:permissions"
