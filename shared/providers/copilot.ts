import type { PermissionsConfig } from "./types"
import { decodeBase64DirName, encodeBase64DirName } from "./base64DirName"

export const COPILOT_PREFIX = "copilot__"

export function isCopilotDirName(dirName: string | null | undefined): boolean {
  return typeof dirName === "string" && dirName.startsWith(COPILOT_PREFIX)
}

/** Encode a project path as a URL-safe Copilot provider directory name. */
export function encodeCopilotDirName(cwd: string): string {
  return encodeBase64DirName(COPILOT_PREFIX, cwd)
}

/** Decode a Copilot provider directory name back to its project path. */
export function decodeCopilotDirName(dirName: string): string | null {
  return decodeBase64DirName(COPILOT_PREFIX, dirName)
}

export function buildCopilotPermArgs(permissions?: PermissionsConfig): string[] {
  return permissions?.mode === "bypassPermissions" || permissions?.mode === "auto"
    ? ["--allow-all"]
    : []
}

export function buildCopilotModelArgs(model?: string): string[] {
  return model ? ["--model", model] : []
}

export function buildCopilotEffortArgs(effort?: string): string[] {
  return effort ? ["--reasoning-effort", effort] : []
}
