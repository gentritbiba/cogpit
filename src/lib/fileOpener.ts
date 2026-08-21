// ── File open routing ───────────────────────────────────────────────────
//
// Every "show me this file" affordance in the app funnels through here. A
// request is served either by Cogpit's built-in file workspace (when the user
// prefers it and a surface is mounted to render it) or by the host's configured
// editor over /api/open-in-editor. Call sites state *what* to open; this module
// owns *where* it opens.

import { authFetch } from "@/lib/auth"
import { can } from "@/lib/capabilities"
import { isRemoteDeviceActive } from "@/lib/device"
import { parentDirectory, relativePathWithin } from "@/lib/paths"
import { copyToClipboard } from "@/lib/utils"

/** "diff" shows the file against its committed version instead of its contents. */
export type FileOpenMode = "file" | "diff"

export interface FileOpenOptions {
  mode?: FileOpenMode
  line?: number
  column?: number
}

/** A resolved thing to show: one file, or a project directory. */
export type FileOpenTarget =
  | ({ kind: "file"; path: string } & FileOpenOptions)
  | { kind: "project"; path: string }

/** A project addressed by host path and/or Claude dirName (the server resolves either). */
export interface ProjectRef {
  path?: string | null
  dirName?: string | null
}

// ── Built-in editor preference ──────────────────────────────────────────
//
// A module cell mirroring the persisted `useBuiltInEditor` setting, in the same
// shape as the capability gate so components can read it at render time. It is
// republished whenever /api/config resolves, which is also when the App subtree
// re-renders — no subscription needed.

let builtInEditorEnabled = false

/** Called by useAppConfig whenever /api/config resolves. */
export function setBuiltInEditorEnabled(enabled: boolean): void {
  builtInEditorEnabled = enabled
}

export function isBuiltInEditorEnabled(): boolean {
  return builtInEditorEnabled
}

// ── Built-in workspace registration ─────────────────────────────────────

/** Returns false when the surface cannot serve the target, so routing falls through. */
export type BuiltInFileOpener = (target: FileOpenTarget) => boolean

let builtInOpener: BuiltInFileOpener | null = null

/** Installed by the shell that renders the file workspace. Returns an unregister fn. */
export function registerBuiltInFileOpener(opener: BuiltInFileOpener): () => void {
  builtInOpener = opener
  return () => {
    if (builtInOpener === opener) builtInOpener = null
  }
}

/** A pending "select this file" instruction handed to the built-in workspace. */
export interface BuiltInEditorRequest {
  /** Root-relative path of the file to select. */
  file: string
  mode: "edit" | "diff"
  line?: number
  /** Increments per request so reopening the same file still applies. */
  token: number
}

export interface BuiltInEditorTarget {
  /** Directory the built-in workspace browses. */
  root: string
  /** Root-relative file to select, or null to open the workspace unfocused. */
  file: string | null
  mode: "edit" | "diff"
  line?: number
}

/**
 * Map a request onto the built-in workspace. Files inside the active project
 * open with the whole project browsable (and its git status alongside);
 * anything else — a skill file, a config outside the repo — falls back to
 * browsing the file's own directory so the request always resolves.
 */
export function resolveBuiltInEditorTarget(
  target: FileOpenTarget,
  projectCwd?: string | null,
): BuiltInEditorTarget | null {
  if (!target.path) return null
  if (target.kind === "project") return { root: target.path, file: null, mode: "edit" }

  if (projectCwd) {
    const projectRelative = relativePathWithin(projectCwd, target.path)
    if (projectRelative) {
      return { root: projectCwd, file: projectRelative, mode: viewFor(target), line: target.line }
    }
  }

  const root = parentDirectory(target.path)
  const file = relativePathWithin(root, target.path)
  if (!file) return null
  return { root, file, mode: viewFor(target), line: target.line }
}

function viewFor(target: { mode?: FileOpenMode }): "edit" | "diff" {
  return target.mode === "diff" ? "diff" : "edit"
}

// ── Routing ─────────────────────────────────────────────────────────────

function handledInternally(target: FileOpenTarget): boolean {
  return builtInEditorEnabled && builtInOpener !== null && builtInOpener(target)
}

/** Fire-and-forget host action; the host surfaces its own failures. */
function postHostAction(endpoint: string, body: Record<string, unknown>): void {
  authFetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }).catch(() => {})
}

/** Open one file — in the built-in workspace, or the host's editor. */
export function openFile(path: string, options: FileOpenOptions = {}): void {
  if (!can("hostFiles")) return
  if (handledInternally({ kind: "file", path, ...options })) return
  // A native editor window would open on the remote machine's screen — copy the
  // path instead so it stays actionable here.
  if (isRemoteDeviceActive()) {
    void copyToClipboard(path)
    return
  }
  postHostAction("/api/open-in-editor", {
    path,
    mode: options.mode ?? "file",
    line: options.line,
    column: options.column,
  })
}

/** Open a whole project — in the built-in workspace, or the host's editor. */
export function openProject(project: ProjectRef): void {
  if (!can("hostFiles")) return
  if (project.path && handledInternally({ kind: "project", path: project.path })) return
  postProjectAction("/api/open-in-editor", project)
}

/** Reveal a project in the OS file manager. Always a host action. */
export function revealInFolder(project: ProjectRef): void {
  if (!can("hostFiles")) return
  postProjectAction("/api/reveal-in-folder", project)
}

function postProjectAction(endpoint: string, project: ProjectRef): void {
  if (!project.path && !project.dirName) return
  postHostAction(endpoint, {
    path: project.path || undefined,
    dirName: project.dirName || undefined,
  })
}

export function __resetFileOpenerForTest(): void {
  builtInEditorEnabled = false
  builtInOpener = null
}
