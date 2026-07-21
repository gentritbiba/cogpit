export interface SessionRecencyLike {
  lastActivityAt?: string | null
  lastModified?: string | null
  dirName?: string
  fileName?: string
  sessionId?: string
}

function parseTimestampMs(value?: string | null): number {
  if (typeof value !== "string" || value.length === 0) return Number.NEGATIVE_INFINITY
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : Number.NEGATIVE_INFINITY
}

export function getSessionRecencyMs(session: SessionRecencyLike): number {
  const activityMs = parseTimestampMs(session.lastActivityAt)
  if (activityMs !== Number.NEGATIVE_INFINITY) return activityMs
  return parseTimestampMs(session.lastModified)
}

function compareNumbersDesc(a: number, b: number): number {
  if (a === b) return 0
  return b - a
}

function identityKey(session: SessionRecencyLike): string {
  return [session.dirName ?? "", session.fileName ?? "", session.sessionId ?? ""].join("/")
}

export function compareSessionsByRecency<T extends SessionRecencyLike>(a: T, b: T): number {
  const recencyDiff = compareNumbersDesc(getSessionRecencyMs(a), getSessionRecencyMs(b))
  if (recencyDiff !== 0) return recencyDiff

  const modifiedDiff = compareNumbersDesc(parseTimestampMs(a.lastModified), parseTimestampMs(b.lastModified))
  if (modifiedDiff !== 0) return modifiedDiff

  return identityKey(a).localeCompare(identityKey(b))
}

export function sortSessionsByRecency<T extends SessionRecencyLike>(sessions: readonly T[]): T[] {
  return [...sessions].sort(compareSessionsByRecency)
}
