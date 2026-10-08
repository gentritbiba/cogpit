import type { ParsedSession } from "./types"

export function instanceSessionId(instanceId: string, nativeId: string): string {
  if (instanceId === "default") return nativeId
  const bytes = new TextEncoder().encode(nativeId)
  const encoded = btoa(Array.from(bytes, (byte) => String.fromCharCode(byte)).join("")).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
  return `i-${instanceId}__${encoded}`
}
export function splitInstanceSessionId(id: string): { instanceId: string; nativeId: string } {
  const match = /^i-([A-Za-z0-9-]+)__([A-Za-z0-9_-]+)$/.exec(id)
  if (!match) return { instanceId: "default", nativeId: id }
  try { const bytes = Uint8Array.from(atob(match[2]!.replace(/-/g, "+").replace(/_/g, "/")), (character) => character.charCodeAt(0)); return { instanceId: match[1]!, nativeId: new TextDecoder("utf-8", { fatal: true }).decode(bytes) } } catch { throw new Error("Invalid instance session ID") }
}
export function instanceDirName(instanceId: string, nativeDirName: string): string { return instanceId === "default" ? nativeDirName : `instance__${instanceId}__${nativeDirName}` }
export function splitInstanceDirName(dirName: string | null | undefined): { instanceId: string; nativeDirName: string } {
  const match = /^instance__([A-Za-z0-9-]+)__(.+)$/.exec(dirName ?? "")
  return match ? { instanceId: match[1]!, nativeDirName: match[2]! } : { instanceId: "default", nativeDirName: dirName ?? "" }
}
export function scopeParsedSession(session: ParsedSession, instanceId: string): ParsedSession {
  if (instanceId === "default") return session
  return { ...session, instanceId, sessionId: instanceSessionId(instanceId, splitInstanceSessionId(session.sessionId).nativeId), ...(session.branchedFrom ? { branchedFrom: { ...session.branchedFrom, sessionId: instanceSessionId(instanceId, splitInstanceSessionId(session.branchedFrom.sessionId).nativeId) } } : {}) }
}
