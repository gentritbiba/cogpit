import { readdir, realpath, stat } from "node:fs/promises"
import { homedir } from "node:os"
import { join, relative, resolve, sep } from "node:path"
import {
  decodeCopilotDirName as decodeProviderCopilotDirName,
  encodeCopilotDirName as encodeProviderCopilotDirName,
  isCopilotDirName as isProviderCopilotDirName,
} from "../shared/providers/copilot"
import {
  decodeCodexDirName as decodeProviderCodexDirName,
  encodeCodexDirName as encodeProviderCodexDirName,
  isCodexDirName as isProviderCodexDirName,
} from "../shared/providers/codex"
import type { AgentKind } from "../shared/providers/types"
import { getConfig, getDirs } from "./config"
import { isWithinDir } from "./pathSafety"
import { getSessionMeta } from "./sessionMetadata"

/** Mutable directory references populated from the active application config. */
export const dirs = {
  PROJECTS_DIR: "",
  TEAMS_DIR: "",
  TASKS_DIR: "",
  UNDO_DIR: "",
  SESSION_CONFIG_DIR: "",
}

export const CODEX_HOME_DIR = resolve(process.env.CODEX_HOME || join(homedir(), ".codex"))
export const CODEX_SESSIONS_DIR = join(CODEX_HOME_DIR, "sessions")
export const COPILOT_HOME_DIR = resolve(process.env.COPILOT_HOME || join(homedir(), ".copilot"))
export const COPILOT_SESSIONS_DIR = join(COPILOT_HOME_DIR, "session-state")

const SESSION_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Delegates to the shared Codex provider directory convention. */
export function isCodexDirName(dirName: string): boolean {
  return isProviderCodexDirName(dirName)
}

/** Delegates to the shared Codex provider directory convention. */
export function encodeCodexDirName(cwd: string): string {
  return encodeProviderCodexDirName(cwd)
}

/** Delegates to the shared Codex provider directory convention. */
export function decodeCodexDirName(dirName: string): string | null {
  return decodeProviderCodexDirName(dirName)
}

export function isCopilotDirName(dirName: string): boolean {
  return isProviderCopilotDirName(dirName)
}

export function encodeCopilotDirName(cwd: string): string {
  return encodeProviderCopilotDirName(cwd)
}

export function decodeCopilotDirName(dirName: string): string | null {
  return decodeProviderCopilotDirName(dirName)
}

export function isCodexFilePath(filePath: string): boolean {
  return resolve(filePath) !== resolve(CODEX_SESSIONS_DIR)
    && isWithinDir(CODEX_SESSIONS_DIR, filePath)
}

export function isCopilotFilePath(filePath: string): boolean {
  return resolve(filePath) !== resolve(COPILOT_SESSIONS_DIR)
    && isWithinDir(COPILOT_SESSIONS_DIR, filePath)
}

export function formatCodexRolloutFileName(sessionId: string, now = new Date()): string {
  const year = String(now.getFullYear())
  const month = String(now.getMonth() + 1).padStart(2, "0")
  const day = String(now.getDate()).padStart(2, "0")
  const hour = String(now.getHours()).padStart(2, "0")
  const minute = String(now.getMinutes()).padStart(2, "0")
  const second = String(now.getSeconds()).padStart(2, "0")
  return `${year}/${month}/${day}/rollout-${year}-${month}-${day}T${hour}-${minute}-${second}-${sessionId}.jsonl`
}

export function refreshDirs(): boolean {
  const config = getConfig()
  if (!config) return false
  const configuredDirs = getDirs(config.claudeDir)
  dirs.PROJECTS_DIR = configuredDirs.PROJECTS_DIR
  dirs.TEAMS_DIR = configuredDirs.TEAMS_DIR
  dirs.TASKS_DIR = configuredDirs.TASKS_DIR
  dirs.UNDO_DIR = configuredDirs.UNDO_DIR
  dirs.SESSION_CONFIG_DIR = configuredDirs.SESSION_CONFIG_DIR
  return true
}

export interface SessionFileInfo {
  filePath: string
  fileName: string
  mtimeMs: number
  size: number
}

export async function listCodexSessionFiles(): Promise<SessionFileInfo[]> {
  const walk = async (dir: string, depth: number): Promise<SessionFileInfo[]> => {
    let entries: import("node:fs").Dirent[] | string[] | undefined
    try {
      entries = await readdir(dir, { withFileTypes: true }) as import("node:fs").Dirent[]
    } catch {
      return []
    }
    if (!Array.isArray(entries)) return []

    const results: SessionFileInfo[] = []
    for (const entry of entries) {
      if (!("name" in entry)) continue
      const filePath = join(dir, entry.name)
      if ("isDirectory" in entry && typeof entry.isDirectory === "function" && entry.isDirectory()) {
        if (depth < 4) results.push(...await walk(filePath, depth + 1))
        continue
      }
      if (!entry.name.endsWith(".jsonl")) continue
      try {
        const fileStat = await stat(filePath)
        results.push({
          filePath,
          // Travels to the client and back as a URL path segment, so it stays
          // forward-slashed regardless of the host separator.
          fileName: relative(CODEX_SESSIONS_DIR, filePath).split(sep).join("/"),
          mtimeMs: fileStat.mtimeMs,
          size: fileStat.size,
        })
      } catch {
        continue
      }
    }
    return results
  }

  return walk(CODEX_SESSIONS_DIR, 0)
}

export async function listCopilotSessionFiles(): Promise<SessionFileInfo[]> {
  let entries: import("node:fs").Dirent[]
  try {
    entries = await readdir(COPILOT_SESSIONS_DIR, { withFileTypes: true })
  } catch {
    return []
  }

  const results = await Promise.all(entries.map(async (entry): Promise<SessionFileInfo | null> => {
    if (!entry.isDirectory() || !SESSION_UUID_RE.test(entry.name)) return null
    const sessionDir = join(COPILOT_SESSIONS_DIR, entry.name)
    const filePath = join(COPILOT_SESSIONS_DIR, entry.name, "events.jsonl")
    try {
      const resolved = await resolveCanonicalFileWithinRoot(
        COPILOT_SESSIONS_DIR,
        sessionDir,
        filePath,
      )
      if (!resolved) return null
      const fileStat = await stat(resolved)
      if (!fileStat.isFile()) return null
      return {
        filePath: resolved,
        fileName: `${entry.name}/events.jsonl`,
        mtimeMs: fileStat.mtimeMs,
        size: fileStat.size,
      }
    } catch {
      return null
    }
  }))
  return results.flatMap((entry) => entry ? [entry] : [])
}

export async function resolveSessionFilePath(dirName: string, fileName: string): Promise<string | null> {
  if (isCodexDirName(dirName)) {
    const filePath = join(CODEX_SESSIONS_DIR, fileName)
    return resolveCanonicalFileWithinRoot(CODEX_SESSIONS_DIR, CODEX_SESSIONS_DIR, filePath)
  }

  if (isCopilotDirName(dirName)) {
    const match = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/events\.jsonl$/i
      .exec(fileName)
    if (!match) return null
    const sessionDir = join(COPILOT_SESSIONS_DIR, match[1])
    return resolveCanonicalFileWithinRoot(
      COPILOT_SESSIONS_DIR,
      sessionDir,
      join(sessionDir, "events.jsonl"),
    )
  }

  if (!isSinglePathSegment(dirName)) return null
  const projectDir = join(dirs.PROJECTS_DIR, dirName)
  const filePath = join(projectDir, fileName)
  return resolveCanonicalFileWithinRoot(dirs.PROJECTS_DIR, projectDir, filePath)
}

function isSinglePathSegment(value: string): boolean {
  return value.length > 0
    && value !== "."
    && value !== ".."
    && !value.includes("/")
    && !value.includes("\\")
    && !value.includes("\0")
}

async function resolveCanonicalFileWithinRoot(
  storageRoot: string,
  requestedRoot: string,
  filePath: string,
): Promise<string | null> {
  const resolvedStorageRoot = resolve(storageRoot)
  const resolvedRequestedRoot = resolve(requestedRoot)
  const resolvedFilePath = resolve(filePath)

  if (!isWithinDir(resolvedStorageRoot, resolvedRequestedRoot)) return null
  if (resolvedFilePath === resolvedRequestedRoot || !isWithinDir(resolvedRequestedRoot, resolvedFilePath)) {
    return null
  }

  try {
    const [canonicalStorageRoot, canonicalRequestedRoot, canonicalFilePath] = await Promise.all([
      realpath(resolvedStorageRoot),
      realpath(resolvedRequestedRoot),
      realpath(resolvedFilePath),
    ])
    if (!isWithinDir(canonicalStorageRoot, canonicalRequestedRoot)) return null
    if (!isWithinDir(canonicalRequestedRoot, canonicalFilePath)) return null
    return resolvedFilePath
  } catch {
    return null
  }
}

export function getAgentKindFromSessionPath(filePath: string | null | undefined): AgentKind {
  if (typeof filePath !== "string") return "claude"
  if (isCodexFilePath(filePath)) return "codex"
  if (isCopilotFilePath(filePath)) return "copilot"
  return "claude"
}

export async function findNewestCodexSessionForCwd(
  cwd: string,
  knownPaths: Set<string>,
  startedAt: number,
): Promise<{ filePath: string; fileName: string; sessionId: string } | null> {
  const files = await listCodexSessionFiles()
  const candidates = files
    .filter((file) => !knownPaths.has(file.filePath) && file.mtimeMs >= startedAt - 1_000)
    .sort((a, b) => b.mtimeMs - a.mtimeMs)

  for (const file of candidates) {
    try {
      const meta = await getSessionMeta(file.filePath)
      if (meta.cwd !== cwd || !meta.sessionId) continue
      return {
        filePath: file.filePath,
        fileName: file.fileName,
        sessionId: meta.sessionId,
      }
    } catch {
      continue
    }
  }

  return null
}

/** Find the JSONL file path for a session across every provider's storage. */
export async function findJsonlPath(sessionId: string): Promise<string | null> {
  if (!isSinglePathSegment(sessionId)) return null
  const targetFile = `${sessionId}.jsonl`
  try {
    const entries = await readdir(dirs.PROJECTS_DIR, { withFileTypes: true })
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name === "memory") continue
      const projectDir = join(dirs.PROJECTS_DIR, entry.name)
      try {
        const files = await readdir(projectDir)
        if (files.includes(targetFile)) {
          return join(projectDir, targetFile)
        }
      } catch {
        continue
      }
    }
  } catch {
    // dirs.PROJECTS_DIR might not exist
  }

  try {
    const codexFiles = await listCodexSessionFiles()
    const match = codexFiles.find((file) => file.fileName.endsWith(`${sessionId}.jsonl`))
    if (match) return match.filePath
  } catch {
    // Ignore Codex lookup errors.
  }

  if (SESSION_UUID_RE.test(sessionId)) {
    const copilotDir = join(COPILOT_SESSIONS_DIR, sessionId)
    const copilotPath = await resolveCanonicalFileWithinRoot(
      COPILOT_SESSIONS_DIR,
      copilotDir,
      join(copilotDir, "events.jsonl"),
    )
    if (copilotPath) return copilotPath
  }
  return null
}
