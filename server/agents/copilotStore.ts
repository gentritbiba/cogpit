import type { Dirent } from "node:fs"
import { readdir } from "node:fs/promises"
import { homedir } from "node:os"
import { basename, dirname, join, resolve } from "node:path"
import { descriptorFor, isSessionUuid } from "../../shared/session/agent-descriptors"
import { isWithinDir } from "../pathSafety"
import { transcriptRootWithin, resolveCanonicalFileWithinRoot, statContainedFile } from "./containment"
import { readCopilotSessionIdentity, readCopilotSessionMeta } from "./copilotMetadata"
import { ownTranscripts } from "./transcriptInventory"
import { addressFromTranscript, projectSessionFilesFromCatalog } from "./transcriptProjects"
import {
  catalogListings,
  createStoreCatalog,
  descriptorAddressing,
  walkStore,
  type CatalogDirListing,
  type StoreCatalogSource,
} from "../sessionCatalog/storeCatalog"
import type { AgentStore } from "./types"

/**
 * Copilot gives every session its own directory: `<session-state>/<uuid>/`,
 * holding `events.jsonl` plus a `workspace.yaml` sidecar. The project it ran in
 * is not in the path, so listings carry no dirName.
 *
 * The root is captured at module load from the environment, which the test
 * fixtures rely on: they set `COPILOT_HOME` before re-importing the module.
 */

export function createCopilotStore(homeDir = process.env.COPILOT_HOME || join(homedir(), ".copilot")): AgentStore {
  const descriptor = descriptorFor("copilot")

  const HOME_DIR = resolve(homeDir)
  const SESSIONS_DIR = join(HOME_DIR, "session-state")

  /** Absolute path of a session's transcript, without checking it exists. */
  function transcriptPath(sessionId: string): { sessionDir: string; filePath: string } {
    const sessionDir = join(SESSIONS_DIR, sessionId)
    return { sessionDir, filePath: join(sessionDir, "events.jsonl") }
  }

  /** The root holds one directory per session; each holds its transcript beside other files. */
  async function listDir(root: string, dir: string, depth: number): Promise<CatalogDirListing> {
    if (depth === 0) {
      let entries: Dirent[]
      try {
        entries = await readdir(root, { withFileTypes: true })
      } catch {
        return { files: [], dirs: [] }
      }
      return { files: [], dirs: entries.filter((entry) => entry.isDirectory() && isSessionUuid(entry.name)).map((entry) => join(root, entry.name)) }
    }
    const sessionId = basename(dir)
    const { filePath } = transcriptPath(sessionId)
    const stats = await statContainedFile(root, filePath)
    return {
      files: stats ? [{ filePath, fileName: descriptor.sessionFile.name(sessionId), dirName: null, ...stats }] : [],
      dirs: [],
    }
  }

  const catalogSource: StoreCatalogSource = {
    root: () => SESSIONS_DIR,
    listDir,
    ...descriptorAddressing(descriptor),
    readIdentity: readCopilotSessionIdentity,
    readSessionMeta: readCopilotSessionMeta,
    // The identity may come from a later resume record or the workspace sidecar, so it is never final.
    identityIsFinal: () => false,
    identitySidecars: (filePath) => [join(dirname(filePath), "workspace.yaml")],
  }
  const catalog = createStoreCatalog(catalogSource)

  const copilotStore: AgentStore = {
    kind: "copilot",
    descriptor,

    sessionsRoot: () => SESSIONS_DIR,

    ownsPath(filePath: string): boolean {
      return resolve(filePath) !== resolve(SESSIONS_DIR) && isWithinDir(SESSIONS_DIR, filePath)
    },

    listSessionFiles: async () => (await walkStore(catalogSource, SESSIONS_DIR)).files,
    // Sub-agents are events inside the parent transcript, never files of their own.
    listTranscripts: async () => ownTranscripts(descriptor, (await walkStore(catalogSource, SESSIONS_DIR)).files),

    async resolveSessionFile(_dirName: string, fileName: string): Promise<string | null> {
      // Only the exact `<uuid>/events.jsonl` shape addresses a Copilot session;
      // the descriptor's inverse rejects everything else, including a bare
      // `<uuid>.jsonl` and backslash variants.
      const sessionId = descriptor.sessionFile.sessionId(fileName)
      if (!sessionId) return null
      const { sessionDir, filePath } = transcriptPath(sessionId)
      return resolveCanonicalFileWithinRoot(SESSIONS_DIR, sessionDir, filePath)
    },

    async findSessionFile(sessionId: string): Promise<string | null> {
      if (!isSessionUuid(sessionId)) return null
      const { sessionDir, filePath } = transcriptPath(sessionId)
      return resolveCanonicalFileWithinRoot(SESSIONS_DIR, sessionDir, filePath)
    },

    transcriptRoot: (filePath) => transcriptRootWithin(SESSIONS_DIR, filePath, descriptor.sessionFile),

    readIdentity: readCopilotSessionIdentity,

    readSessionMeta: readCopilotSessionMeta,

    ...catalogListings(catalog),

    listProjectSessionFiles: (dirName) => projectSessionFilesFromCatalog(copilotStore, catalog, dirName),

    // Sub-agents are `subagent.*` events inside the parent transcript, not files.
    listSubagentFiles: async () => [],
    agentsWroteSince: async () => false,

    sessionAddress: (filePath) => addressFromTranscript(copilotStore, filePath),

    transcriptPath(_dirName, sessionId) {
      return { filePath: transcriptPath(sessionId).filePath, fileName: descriptor.sessionFile.name(sessionId) }
    },
  }
  return copilotStore
}

export const copilotStore = createCopilotStore()
