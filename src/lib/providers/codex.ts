import { isCodexSessionText } from "../codex"
import type { SessionProvider, PermissionsConfig } from "./types"

export const CODEX_PREFIX = "codex__"

// ── Directory name helpers ────────────────────────────────────────────────────

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

/**
 * Decode a Codex dirName back to a filesystem path.
 * Returns null if the dirName is not a valid Codex dirName.
 */
export function decodeCodexDirName(dirName: string): string | null {
  if (!isCodexDirName(dirName)) return null
  try {
    const b64 = dirName.slice(CODEX_PREFIX.length).replace(/-/g, "+").replace(/_/g, "/")
    const binary = atob(b64)
    const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0))
    return new TextDecoder().decode(bytes)
  } catch {
    return null
  }
}

// ── CLI arg builders ──────────────────────────────────────────────────────────

export function buildCodexPermArgs(permissions?: PermissionsConfig): string[] {
  switch (permissions?.mode) {
    case "bypassPermissions":
      return ["--dangerously-bypass-approvals-and-sandbox"]
    case "dontAsk":
      return ["-a", "never", "-s", "workspace-write"]
    case "plan":
      return ["-a", "untrusted", "-s", "read-only"]
    case "default":
    case "acceptEdits":
    case "delegate":
    default:
      return ["-a", "on-request", "-s", "workspace-write"]
  }
}

export function buildCodexEffortArgs(effort?: string): string[] {
  return effort ? ["-c", `model_reasoning_effort=${JSON.stringify(effort)}`] : []
}

export function buildCodexModelArgs(model?: string): string[] {
  return model ? ["-m", model] : []
}

// ── Resume command ────────────────────────────────────────────────────────────

export function getCodexResumeCommand(sessionId: string): string {
  return `codex resume ${sessionId}`
}

// ── Provider object ───────────────────────────────────────────────────────────

export const codexProvider: SessionProvider = {
  kind: "codex",
  isDirName: isCodexDirName,
  isSessionText: isCodexSessionText,
  resumeCommand: getCodexResumeCommand,
  buildPermArgs: buildCodexPermArgs,
  buildModelArgs: buildCodexModelArgs,
  buildEffortArgs: buildCodexEffortArgs,
}
