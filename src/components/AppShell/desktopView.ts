import type { MainView } from "@/hooks/useSessionState"
import type { ProjectPromptContext } from "@/plugin-api"

export type DesktopMainView =
  | "config"
  | "mission"
  | "extension"
  | "session"
  | "pending"
  | "dashboard"

interface ResolveDesktopMainViewOptions {
  mainView: MainView
  hasSession: boolean
  pendingDirName: string | null
  /** An edition main view the caller may no longer open (a sign-out, a demotion) falls through. */
  extensionViewAvailable: boolean
}

/** Preserve the shell's view precedence in one explicit, testable decision. */
export function resolveDesktopMainView({
  mainView,
  hasSession,
  pendingDirName,
  extensionViewAvailable,
}: ResolveDesktopMainViewOptions): DesktopMainView {
  if (mainView === "config") return "config"
  // Mission Control outranks an open session on purpose: it is where the user
  // goes to find what is blocked while already deep in another session.
  if (mainView === "mission") return "mission"
  if (mainView === "extension" && extensionViewAvailable) return "extension"
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
