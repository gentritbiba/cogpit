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

/** The mode that lets an agent act without asking; the picker warns before it. */
export const FULL_ACCESS_MODE: PermissionMode = "bypassPermissions"

/**
 * The access picker's value until someone on this device chooses one. A new
 * install starts in each agent's ask-first mode; an install from before keeps
 * the Full access its users have always had.
 */
export function defaultPermissions(freshInstall: boolean): PermissionsConfig {
  return { mode: freshInstall ? "default" : FULL_ACCESS_MODE, allowedTools: [], disallowedTools: [] }
}

export const PERMISSIONS_STORAGE_KEY = "cogpit:permissions"
