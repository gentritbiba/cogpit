import { mkdir, readdir, readFile } from "node:fs/promises"
import { join } from "node:path"
import { writeOwnerOnlyJson } from "../atomicJsonFile"

/**
 * Whether this Cogpit started on a machine with no Cogpit data of its own, as
 * decided once by the first server that recorded it. New installs start with
 * safer defaults; installs that existed before keep the behavior their users
 * rely on, whether or not they ever changed a setting.
 */
export interface InstallState {
  freshInstall: boolean
}

const STATE_FILE = "install-state.json"

/**
 * What earlier Cogpit servers leave in the data folder. The folder may also
 * hold the desktop shell's browser profile, which proves nothing about Cogpit.
 */
const EARLIER_DATA = [
  "config.local.json",
  "session-config",
  "undo-history",
  "plugin-host-classification",
  "runtime-plugins",
  "orchestration",
  "devices.local.json",
  "shares.local.json",
]

let recorded: InstallState | null = null

async function readRecorded(path: string): Promise<InstallState | null> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, "utf-8"))
    if (parsed && typeof parsed === "object" && typeof (parsed as InstallState).freshInstall === "boolean") {
      return { freshInstall: (parsed as InstallState).freshInstall }
    }
  } catch {
    // Missing or unreadable: decided below.
  }
  return null
}

async function holdsEarlierData(dataDir: string): Promise<boolean> {
  const entries = await readdir(dataDir).catch(() => [] as string[])
  return entries.some((entry) => EARLIER_DATA.includes(entry))
}

/**
 * Read the recorded install state, or decide and record it. Call it before
 * anything else writes to `dataDir` on this start, so this server's own files
 * are not taken for an earlier install's.
 */
export async function captureInstallState(dataDir: string): Promise<InstallState> {
  const path = join(dataDir, STATE_FILE)
  const existing = await readRecorded(path)
  if (existing) {
    recorded = existing
    return existing
  }
  const state: InstallState = { freshInstall: !(await holdsEarlierData(dataDir)) }
  try {
    await mkdir(dataDir, { recursive: true })
    await writeOwnerOnlyJson(path, { ...state, recordedAt: new Date().toISOString() })
  } catch (error) {
    // Unrecorded, the next start decides again and finds this one's files.
    console.warn(`[install-state] Could not record ${path}: ${error instanceof Error ? error.message : String(error)}`)
  }
  recorded = state
  return state
}

/** The state this server captured; an install it never captured counts as an earlier one. */
export function installState(): InstallState {
  return recorded ?? { freshInstall: false }
}

export function _resetInstallStateForTests(): void {
  recorded = null
}
