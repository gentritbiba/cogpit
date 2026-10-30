import type { MainView } from "@/hooks/useSessionState"
import { newContextId, type FileContext } from "../../../shared/session/composerContext"
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

/**
 * A project file as the composer takes it: an excerpt as typed context (its
 * review comment included), or, with no excerpt, null — a whole file goes in
 * as an `@path` mention the agent resolves itself.
 */
export function projectContextItem({ path, text, startLine, endLine, comment }: ProjectPromptContext): FileContext | null {
  if (!text) return null
  return { id: newContextId(), kind: "file", path, text, ...(startLine !== undefined ? { startLine, endLine: endLine ?? startLine } : {}), ...(comment ? { comment } : {}) }
}
