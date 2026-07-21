import type { ProjectPromptContext } from "@/components/ProjectFilesPanel"

export type DesktopMainView = "config" | "teams" | "session" | "pending" | "dashboard"

interface ResolveDesktopMainViewOptions {
  mainView: "sessions" | "config" | "teams"
  selectedTeam: string | null
  hasSession: boolean
  pendingDirName: string | null
}

/** Preserve the shell's view precedence in one explicit, testable decision. */
export function resolveDesktopMainView({
  mainView,
  selectedTeam,
  hasSession,
  pendingDirName,
}: ResolveDesktopMainViewOptions): DesktopMainView {
  if (mainView === "config") return "config"
  if (mainView === "teams" && selectedTeam) return "teams"
  if (hasSession) return "session"
  if (pendingDirName) return "pending"
  return "dashboard"
}

interface ResolveDesktopProjectPathOptions {
  sessionCwd?: string | null
  pendingPath?: string | null
  sessionDirPath?: string | null
  dashboardProjectPath?: string | null
}

export function resolveDesktopProjectPath({
  sessionCwd,
  pendingPath,
  sessionDirPath,
  dashboardProjectPath,
}: ResolveDesktopProjectPathOptions): string | null {
  return sessionCwd
    ?? pendingPath
    ?? sessionDirPath
    ?? dashboardProjectPath
    ?? null
}

export function formatProjectPromptContext({
  path,
  text,
  startLine,
  endLine,
  comment,
}: ProjectPromptContext): string {
  if (!text) return `@${path}`

  const fence = text.includes("```") ? "````" : "```"
  const lines = startLine === endLine ? `line ${startLine}` : `lines ${startLine}-${endLine}`
  return `${comment ? `Review request: ${comment}\n` : ""}${path} (${lines})\n${fence}\n${text}\n${fence}`
}
