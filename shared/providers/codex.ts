import type { PermissionsConfig } from "./types"

export const CODEX_PREFIX = "codex__"

export function isCodexDirName(dirName: string | null | undefined): boolean {
  return typeof dirName === "string" && dirName.startsWith(CODEX_PREFIX)
}

/**
 * Encode a filesystem path as a Codex provider dirName.
 * Uses URL-safe base64 (no padding) to avoid filesystem-unsafe characters.
 * Compatible with both browser (btoa) and Node.js 18+ (globalThis.btoa).
 */
export function encodeCodexDirName(cwd: string): string {
  const bytes = new TextEncoder().encode(cwd)
  let binary = ""
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return `${CODEX_PREFIX}${btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")}`
}

/** Decode a Codex dirName back to a filesystem path, or null when invalid. */
export function decodeCodexDirName(dirName: string): string | null {
  if (!isCodexDirName(dirName)) return null
  try {
    const b64 = dirName.slice(CODEX_PREFIX.length).replace(/-/g, "+").replace(/_/g, "/")
    const binary = atob(b64)
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0))
    return new TextDecoder().decode(bytes)
  } catch {
    return null
  }
}

export function buildCodexPermArgs(permissions?: PermissionsConfig): string[] {
  const mode = permissions?.mode || "default"
  if (mode === "bypassPermissions") {
    return ["--dangerously-bypass-approvals-and-sandbox"]
  }

  // `codex exec` is non-interactive, so it cannot present an approval prompt.
  // Keep execution inside a sandbox and return denied operations to the model
  // instead of silently granting full machine access. The app-server adapter
  // upgrades this to interactive approvals when it owns the live thread.
  return [
    "--sandbox",
    mode === "plan" ? "read-only" : "workspace-write",
    "-c",
    'approval_policy="never"',
  ]
}

export function buildCodexEffortArgs(effort?: string): string[] {
  return effort ? ["-c", `model_reasoning_effort=${JSON.stringify(effort)}`] : []
}

export function buildCodexModelArgs(model?: string): string[] {
  return model ? ["-m", model] : []
}

export function buildCodexFastModeArgs(enabled?: boolean): string[] {
  return enabled
    ? ["-c", 'service_tier="fast"', "--enable", "fast_mode"]
    : []
}
