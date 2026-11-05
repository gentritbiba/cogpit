import { readdirSync, statSync } from "node:fs"
import { mkdir, readFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import { writeOwnerOnlyJson } from "../atomicJsonFile"

/**
 * Whether this Cogpit started on a machine with no Cogpit of its own before,
 * decided once per data folder. New installs start with safer defaults; any
 * install with earlier Cogpit evidence keeps the behavior its users rely on,
 * whether or not they ever changed a setting. Doubt always means "earlier".
 */
export interface InstallState {
  freshInstall: boolean
}

const STATE_FILE = "install-state.json"

/**
 * What earlier Cogpit servers leave in the data folder. The folder may also
 * hold the desktop shell's browser profile, which proves nothing about Cogpit.
 */
const EARLIER_DATA = new Set([
  "config.local.json",
  "session-config",
  "undo-history",
  "plugin-host-classification",
  "runtime-plugins",
  "runtime-plugin-connections",
  "orchestration",
  "devices.local.json",
  "shares.local.json",
  "session-creation-requests",
  "provider-instances",
  "result-refs.key",
  "usage-model-rates.json",
  "search-index.db",
])

/**
 * The Cogpit home every server writes to (`bin/`, `port`, `browser/`,
 * `notifications.json`), and the parts of it the environment moves elsewhere.
 * Whichever shell and data folder an earlier Cogpit used, it left one of these.
 */
export function cogpitHomeLocations(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string[] {
  return [
    join(home, ".cogpit"),
    env.COGPIT_BROWSER_HOME,
    env.COGPIT_WORKSPACES_DIR,
    env.COGPIT_SLACK_DIR,
  ].filter((path): path is string => Boolean(path))
}

const NOT_THERE = new Set(["ENOENT", "ENOTDIR"])

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | null)?.code
}

/** True when `path` exists, or cannot be ruled out. */
function mayExist(path: string): boolean {
  try {
    statSync(path)
    return true
  } catch (error) {
    return !NOT_THERE.has(errorCode(error) ?? "")
  }
}

function holdsEarlierData(dataDir: string): boolean {
  try {
    return readdirSync(dataDir).some((entry) => EARLIER_DATA.has(entry))
  } catch (error) {
    return !NOT_THERE.has(errorCode(error) ?? "")
  }
}

/** The recorded answer; null when none was recorded; "earlier" when a record exists but cannot be read. */
async function readRecorded(path: string): Promise<InstallState | "earlier" | null> {
  let text: string
  try {
    text = await readFile(path, "utf-8")
  } catch (error) {
    return NOT_THERE.has(errorCode(error) ?? "") ? null : "earlier"
  }
  try {
    const parsed: unknown = JSON.parse(text)
    const freshInstall = (parsed as Partial<InstallState> | null)?.freshInstall
    return typeof freshInstall === "boolean" ? { freshInstall } : "earlier"
  } catch {
    return "earlier"
  }
}

async function decide(dataDir: string, earlierEvidence: boolean): Promise<InstallState> {
  const path = join(dataDir, STATE_FILE)
  const recorded = await readRecorded(path)
  if (recorded !== null && recorded !== "earlier") return recorded
  const fresh = recorded === null && !earlierEvidence
  const state: InstallState = { freshInstall: fresh }
  try {
    await mkdir(dataDir, { recursive: true })
    await writeOwnerOnlyJson(path, { ...state, recordedAt: new Date().toISOString() })
  } catch (error) {
    // Unrecorded, the next start decides again and finds this one's files: an earlier install.
    console.warn(`[install-state] Could not record ${path}: ${error instanceof Error ? error.message : String(error)}`)
  }
  return state
}

const starts = new Map<string, Promise<InstallState>>()
let current: InstallState | null = null

export interface ServerStartOptions {
  env?: NodeJS.ProcessEnv
  home?: string
}

/**
 * The first thing every shell does when it starts a server for `dataDir`:
 * look for an earlier Cogpit before this start writes anything of its own,
 * and record the answer in the data folder, which keeps it from then on.
 * Later calls for the same folder in this process share the first answer, so
 * a shell that hands its folder to another (standalone to composition, Vite's
 * API plugin to its terminal plugin) cannot ask again after writing.
 */
export function beginServerStart(dataDir: string, { env = process.env, home }: ServerStartOptions = {}): Promise<InstallState> {
  const started = starts.get(dataDir)
  if (started) return started
  // Looked at synchronously, before this start can write anything of its own.
  const earlierEvidence = cogpitHomeLocations(env, home ?? homedir()).some(mayExist) || holdsEarlierData(dataDir)
  const decided = decide(dataDir, earlierEvidence).then((state) => {
    current = state
    return state
  })
  starts.set(dataDir, decided)
  return decided
}

/** The state this server decided; a server that never started one counts as an earlier install. */
export function installState(): InstallState {
  return current ?? { freshInstall: false }
}

export function _resetInstallStateForTests(): void {
  starts.clear()
  current = null
}
