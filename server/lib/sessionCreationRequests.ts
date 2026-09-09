import { createHash } from "node:crypto"
import { mkdir, open, readFile } from "node:fs/promises"
import { join } from "node:path"
import type { StartedSession, StartSessionRequest } from "../agents/runtimeTypes"
import { writeOwnerOnlyJson } from "../atomicJsonFile"
import { ErrorCodes, RouteError } from "./routeError"

interface CreationRecord {
  fingerprint: string
  result?: StartedSession
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return item
    return Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)))
  })
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex")
}

export class SessionCreationRequests {
  private pending = new Map<string, { fingerprint: string; result: Promise<StartedSession> }>()

  constructor(private directory: () => string) {}

  async run(
    scope: string,
    requestId: unknown,
    request: StartSessionRequest,
    start: () => Promise<StartedSession>,
  ): Promise<StartedSession> {
    if (typeof requestId !== "string" || !/^[a-zA-Z0-9_-]{8,128}$/.test(requestId)) {
      throw new RouteError(400, ErrorCodes.INVALID_REQUEST, "requestId must contain 8–128 letters, digits, underscores or hyphens")
    }
    const file = join(this.directory(), `${digest(JSON.stringify([scope, requestId]))}.json`)
    const fingerprint = digest(canonicalJson(request))
    const pending = this.pending.get(file)
    if (pending) {
      this.checkFingerprint(pending.fingerprint, fingerprint)
      return pending.result
    }

    const result = this.create(file, fingerprint, start)
    this.pending.set(file, { fingerprint, result })
    try {
      return await result
    } finally {
      this.pending.delete(file)
    }
  }

  private checkFingerprint(existing: string, requested: string): void {
    if (existing !== requested) {
      throw new RouteError(409, ErrorCodes.CONFLICT, "requestId was already used with a different session request")
    }
  }

  private async create(
    file: string,
    fingerprint: string,
    start: () => Promise<StartedSession>,
  ): Promise<StartedSession> {
    await mkdir(this.directory(), { recursive: true, mode: 0o700 })
    let claim
    try {
      claim = await open(file, "wx", 0o600)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
      let record: CreationRecord
      try {
        record = JSON.parse(await readFile(file, "utf8")) as CreationRecord
      } catch {
        throw this.unknownOutcome()
      }
      this.checkFingerprint(record.fingerprint, fingerprint)
      if (!record.result) throw this.unknownOutcome()
      return record.result
    }

    try {
      await claim.writeFile(JSON.stringify({ fingerprint } satisfies CreationRecord))
      await claim.sync()
    } finally {
      await claim.close()
    }
    // Keep the claim if spawning or saving fails: the agent may already exist.
    const result = await start()
    await writeOwnerOnlyJson(file, { fingerprint, result } satisfies CreationRecord)
    return result
  }

  private unknownOutcome(): RouteError {
    return new RouteError(409, ErrorCodes.CONFLICT,
      "Session creation is pending or its outcome is unknown. Retry with the same requestId; inspect active sessions before starting a new request.")
  }
}
