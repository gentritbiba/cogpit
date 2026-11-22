import { randomBytes } from "node:crypto"
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { writeOwnerOnlyJson } from "../atomicJsonFile"

/** What this install remembers about usage data, in `telemetry.json` in the data folder. */
export interface TelemetryState {
  /** Random, made here, and never derived from anything about the person or machine. */
  installId: string
  /** The last UTC day whose usage was reported, `YYYY-MM-DD`. */
  usageReportedThrough: string | null
  /**
   * Sessions started or messaged from Cogpit, with when that last happened.
   * Usage is reported for these only, never for agent work outside Cogpit.
   * Kept on this computer.
   */
  sessions: Record<string, number>
}

const FILE = "telemetry.json"
const SESSION_RETENTION_MS = 45 * 24 * 60 * 60 * 1000
const MAX_SESSIONS = 5_000

export function statePath(dataDir: string): string {
  return join(dataDir, FILE)
}

export function initialState(): TelemetryState {
  return { installId: randomBytes(16).toString("hex"), usageReportedThrough: null, sessions: {} }
}

/** The saved state, or null when there is none or it cannot be read as one. */
export async function readState(dataDir: string): Promise<TelemetryState | null> {
  let parsed: Partial<TelemetryState>
  try {
    parsed = JSON.parse(await readFile(statePath(dataDir), "utf-8")) as Partial<TelemetryState>
  } catch {
    return null
  }
  if (typeof parsed?.installId !== "string" || !/^[0-9a-f]{32}$/.test(parsed.installId)) return null
  const sessions: Record<string, number> = {}
  if (parsed.sessions && typeof parsed.sessions === "object") {
    for (const [id, seen] of Object.entries(parsed.sessions)) {
      if (typeof seen === "number" && Number.isFinite(seen)) sessions[id] = seen
    }
  }
  return {
    installId: parsed.installId,
    usageReportedThrough: typeof parsed.usageReportedThrough === "string" && /^\d{4}-\d{2}-\d{2}$/.test(parsed.usageReportedThrough)
      ? parsed.usageReportedThrough
      : null,
    sessions,
  }
}

/** Drop sessions too old to report on, keeping the newest when there are too many. */
export function pruneSessions(sessions: Record<string, number>, now: number): Record<string, number> {
  const kept = Object.entries(sessions)
    .filter(([, seen]) => now - seen < SESSION_RETENTION_MS)
    .sort(([, a], [, b]) => b - a)
    .slice(0, MAX_SESSIONS)
  return Object.fromEntries(kept)
}

export async function writeState(dataDir: string, state: TelemetryState): Promise<void> {
  await writeOwnerOnlyJson(statePath(dataDir), state)
}
