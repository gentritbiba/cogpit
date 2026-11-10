import type { Dirent } from "node:fs"
import { readdir } from "node:fs/promises"
import { homedir } from "node:os"
import { join, resolve } from "node:path"
import { descriptorFor, isSessionUuid } from "../../shared/session/agent-descriptors"
import { isWithinDir } from "../pathSafety"
import { readCodexSessionIdentity, readCodexSessionMeta } from "./codexMetadata"
import { transcriptRootWithin, resolveCanonicalFileWithinRoot, statContainedFile } from "./containment"
import { isCompressedTranscript, isListableTranscript, uncompressedTranscriptName } from "./transcriptFile"
import { HEAD_BYTES } from "./transcriptHead"
import { ownTranscripts } from "./transcriptInventory"
import { addressFromTranscript, projectSessionFilesFromCatalog } from "./transcriptProjects"
import {
  catalogListings,
  createStoreCatalog,
  descriptorAddressing,
  rootRelativeName,
  walkStore,
  type CatalogDirListing,
  type StoreCatalogSource,
} from "../sessionCatalog/storeCatalog"
import type { AgentStore, SessionFileInfo, SubagentFileInfo } from "./types"

/**
 * Codex writes one rollout per session into a date-nested tree:
 * `$CODEX_HOME/sessions/YYYY/MM/DD/rollout-<ts>-<sessionId>.jsonl`. The project
 * a rollout belongs to appears only inside the file, so listings carry no
 * dirName. Codex compresses a rollout it has stopped writing to
 * `<name>.jsonl.zst`; a listing names it by its plain `.jsonl` name, so its
 * address survives compression and the resume that reverses it.
 *
 * The root is captured at module load from the environment, which the test
 * fixtures rely on: they set `CODEX_HOME` before re-importing the module.
 */

export function createCodexStore(homeDir = process.env.CODEX_HOME || join(homedir(), ".codex")): AgentStore {
  const descriptor = descriptorFor("codex")

  const HOME_DIR = resolve(homeDir)
  const SESSIONS_DIR = join(HOME_DIR, "sessions")

  /** The dated tree is `YYYY/MM/DD/<file>`; nothing legitimate sits deeper. */
  const MAX_WALK_DEPTH = 4

  async function listDir(root: string, dir: string, depth: number): Promise<CatalogDirListing> {
    let entries: Dirent[]
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return { files: [], dirs: [] }
    }

    const names = new Set(entries.map((entry) => entry.name))
    const listing: CatalogDirListing = { files: [], dirs: [] }
    for (const entry of entries) {
      const filePath = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (depth < MAX_WALK_DEPTH) listing.dirs.push(filePath)
        continue
      }
      if (!isListableTranscript(entry.name, names)) continue
      const stats = await statContainedFile(root, filePath)
      if (!stats) continue
      listing.files.push({
        filePath,
        // Travels to the client and back as a URL path segment, so it stays
        // forward-slashed regardless of the host separator.
        fileName: uncompressedTranscriptName(rootRelativeName(root, filePath)),
        dirName: null,
        ...stats,
      })
    }
    return listing
  }

  const catalogSource: StoreCatalogSource = {
    root: () => SESSIONS_DIR,
    listDir,
    ...descriptorAddressing(descriptor),
    readIdentity: readCodexSessionIdentity,
    readSessionMeta: readCodexSessionMeta,
    // A rollout is only appended to, so once its head is written whole the identity in it is fixed.
    identityIsFinal: (filePath, size) => isCompressedTranscript(filePath) || size > HEAD_BYTES,
  }
  const catalog = createStoreCatalog(catalogSource)

  async function walk(): Promise<SessionFileInfo[]> {
    return (await walkStore(catalogSource, SESSIONS_DIR)).files
  }

  async function findSessionFile(sessionId: string): Promise<string | null> {
    // The rollout name prefixes the id with a timestamp, so there is no path to
    // compute up front. Only a whole id may match: a fragment of one would pick
    // whichever rollout the walk met first.
    if (!isSessionUuid(sessionId)) return null
    const files = await walk()
    return files.find((file) => descriptor.sessionFile.sessionId(file.fileName) === sessionId)?.filePath ?? null
  }

  const codexStore: AgentStore = {
    kind: "codex",
    descriptor,

    sessionsRoot: () => SESSIONS_DIR,

    ownsPath(filePath: string): boolean {
      return resolve(filePath) !== resolve(SESSIONS_DIR) && isWithinDir(SESSIONS_DIR, filePath)
    },

    listSessionFiles: walk,
    // A sub-agent's rollout is a session of its own, so the walk already holds it.
    listTranscripts: async () => ownTranscripts(descriptor, await walk()),

    async resolveSessionFile(_dirName: string, fileName: string): Promise<string | null> {
      // The UI addresses a rollout two ways the dated tree does not: a parent's
      // virtual `<parent>/subagents/agent-<id>.jsonl` path, and a bare
      // `<id>.jsonl`. Both resolve by id; the literal path under the root is
      // what a listing handed out.
      const idMatch = fileName.match(/\/subagents\/agent-([^.]+)\.jsonl$/)
        ?? fileName.match(/^([^/]+)\.jsonl$/)
      if (idMatch) {
        const resolved = await findSessionFile(idMatch[1])
        if (resolved) return resolved
      }
      // Codex dirNames encode a cwd rather than a directory on disk, so the
      // fileName alone locates the rollout, relative to the sessions root.
      const filePath = join(SESSIONS_DIR, fileName)
      return await resolveCanonicalFileWithinRoot(SESSIONS_DIR, SESSIONS_DIR, filePath)
        ?? (isCompressedTranscript(filePath) ? null : resolveCanonicalFileWithinRoot(SESSIONS_DIR, SESSIONS_DIR, `${filePath}.zst`))
    },

    findSessionFile,

    transcriptRoot: (filePath) => transcriptRootWithin(SESSIONS_DIR, filePath, descriptor.sessionFile),

    readIdentity: readCodexSessionIdentity,

    readSessionMeta: readCodexSessionMeta,

    ...catalogListings(catalog),

    listProjectSessionFiles: (dirName) => projectSessionFilesFromCatalog(codexStore, catalog, dirName),

    async listSubagentFiles(_dirName: string, parentSessionId: string): Promise<SubagentFileInfo[]> {
      // Rollouts are flat: a sub-agent is any rollout whose header names this
      // session as the one it was spawned from.
      const listing: SubagentFileInfo[] = []
      for (const { file, identity } of await catalog.entries()) {
        if (!identity?.isSubagent || identity.parentSessionId !== parentSessionId) continue
        listing.push({
          agentId: identity.sessionId,
          fileName: file.fileName,
          size: file.size,
          modifiedAt: file.mtimeMs,
        })
      }
      return listing
    },

    // A child rollout is found only by the full inventory walk, too costly to
    // poll; the app-server reports its children's turns directly instead.
    agentsWroteSince: async () => false,

    sessionAddress: (filePath) => addressFromTranscript(codexStore, filePath),

    transcriptPath(_dirName, sessionId) {
      const fileName = descriptor.sessionFile.name(sessionId)
      return { filePath: join(SESSIONS_DIR, fileName), fileName }
    },
  }
  return codexStore
}

export const codexStore = createCodexStore()
