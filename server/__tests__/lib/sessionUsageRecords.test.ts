// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"

import { emptyUsageCostTotals } from "../../../shared/contracts/usageCost"
import { runtimeFor } from "../../agents/runtimes"
import type { UsageCostRecord } from "../../agents/usageScanners"
import { dirs } from "../../dirs"
import { everyChildTranscript } from "../../edition/transcript"
import { readTranscriptRecords } from "../../lib/usageCost/reader"
import { readSessionUsageCostSummary, readSessionUsageRecords, type UsageTranscript } from "../../lib/usageCost/service"

/** Every transcript parse is recorded, so a test can tell a cached read from a fresh one. */
vi.mock("../../lib/usageCost/reader", async (importOriginal) => {
  const reader = await importOriginal<typeof import("../../lib/usageCost/reader")>()
  return { ...reader, readTranscriptRecords: vi.fn(reader.readTranscriptRecords) }
})

const PROJECT = "-work-project"
const SESSION = "5f0c2a1e-7b8d-4c3e-9a6f-1d2e3f4a5b6c"
const OTHER = "6a1d3b2f-8c9e-4d4f-8b7a-2e3f4a5b6c7d"
const SUBAGENT = `${SESSION}/subagents/agent-a7264b922eed1be42.jsonl`
const MODEL = "test-model"
const DAY = 24 * 60 * 60 * 1000

let root: string
let previousProjectsDir: string

function usageLine(messageId: string, timestamp: string, outputTokens: number): string {
  return JSON.stringify({
    type: "assistant",
    sessionId: SESSION,
    timestamp,
    requestId: `req-${messageId}`,
    message: { id: messageId, model: MODEL, usage: { input_tokens: 10, output_tokens: outputTokens } },
  })
}

async function writeTranscript(fileName: string, lines: string[]): Promise<string> {
  const filePath = join(dirs.PROJECTS_DIR, PROJECT, fileName)
  await mkdir(dirname(filePath), { recursive: true })
  await writeFile(filePath, `${lines.join("\n")}\n`)
  return filePath
}

/** The transcript at `fileName`, as the session it names reads it: a child agent's names none. */
function transcript(fileName: string): UsageTranscript {
  const sessionId = fileName.endsWith(".jsonl") && !fileName.includes("/") ? fileName.slice(0, -".jsonl".length) : null
  return { dirName: PROJECT, fileName, filePath: join(dirs.PROJECTS_DIR, PROJECT, fileName), sessionId, visibleChildren: everyChildTranscript }
}

/** How many times the transcript at `filePath` was parsed. */
function parses(filePath: string): number {
  return vi.mocked(readTranscriptRecords).mock.calls.filter(([path]) => path === filePath).length
}

function liveRecord(sessionId: string, outputTokens: number): UsageCostRecord {
  return {
    provider: "claude",
    timestampMs: Date.parse("2026-09-20T10:05:00.000Z"),
    model: MODEL,
    sessionId,
    totals: { ...emptyUsageCostTotals(), outputTokens },
    reportedCostUsd: null,
    speed: null,
    dedupeKey: null,
  }
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "cogpit-session-usage-records-"))
  previousProjectsDir = dirs.PROJECTS_DIR
  dirs.PROJECTS_DIR = join(root, "projects")
  await writeTranscript(`${SESSION}.jsonl`, [
    usageLine("msg-1", "2026-09-20T10:00:00.000Z", 5),
    usageLine("msg-2", "2026-09-20T10:01:00.000Z", 7),
  ])
  await writeTranscript(SUBAGENT, [usageLine("msg-sub", "2026-09-20T10:00:30.000Z", 3)])
})

afterEach(async () => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  dirs.PROJECTS_DIR = previousProjectsDir
  await rm(root, { recursive: true, force: true })
})

describe("readSessionUsageRecords", () => {
  it("reads a session's own transcript and every child agent's", async () => {
    const usage = await readSessionUsageRecords(transcript(`${SESSION}.jsonl`))

    expect(usage).toMatchObject({ provider: "claude", sessionId: SESSION, files: 2 })
    expect(usage?.records.map(({ record, isSubagent }) => [record.dedupeKey, isSubagent])).toEqual([
      ["msg-1:req-msg-1", false],
      ["msg-2:req-msg-2", false],
      ["msg-sub:req-msg-sub", true],
    ])
  })

  it("reads a child agent's own transcript alone", async () => {
    const usage = await readSessionUsageRecords(transcript(SUBAGENT))

    expect(usage?.files).toBe(1)
    expect(usage?.records.map(({ record, isSubagent }) => [record.dedupeKey, isSubagent])).toEqual([["msg-sub:req-msg-sub", true]])
  })

  it("adds the usage an open runtime holds for the session, accrued since its latest record on disk, asking for that session alone", async () => {
    const runtime = runtimeFor("claude")
    vi.spyOn(runtime, "hasSession").mockImplementation((sessionId) => sessionId === SESSION)
    const live = vi.spyOn(runtime, "liveUsageRecords").mockResolvedValue([liveRecord(SESSION, 11)])

    const usage = await readSessionUsageRecords(transcript(`${SESSION}.jsonl`))

    expect(usage?.records.at(-1)).toEqual({
      record: { ...liveRecord(SESSION, 11), accruedSinceMs: Date.parse("2026-09-20T10:01:00.000Z") },
      isSubagent: false,
    })
    expect(usage?.records).toHaveLength(4)
    const [counted, sessionIds] = live.mock.calls[0]
    expect(counted.get(SESSION)?.get(MODEL)?.outputTokens).toBe(15)
    expect(sessionIds).toEqual(new Set([SESSION]))
  })

  it("answers null for an address that resolves to no transcript", async () => {
    expect(await readSessionUsageRecords(transcript(`${OTHER}.jsonl`))).toBeNull()
  })

  it("forgets a transcript last written more than 90 days ago once an hour has passed", async () => {
    const now = Date.now()
    vi.useFakeTimers({ toFake: ["Date"], now })
    const aged = await writeTranscript(`${OTHER}.jsonl`, [usageLine("msg-aged", "2026-01-01T00:00:00.000Z", 1)])
    await utimes(aged, (now - 100 * DAY) / 1000, (now - 100 * DAY) / 1000)
    const readAged = () => readSessionUsageRecords(transcript(`${OTHER}.jsonl`))

    await readAged()
    await readAged()
    expect(parses(aged)).toBe(1)

    vi.setSystemTime(now + 2 * 60 * 60 * 1000)
    await readSessionUsageRecords(transcript(`${SESSION}.jsonl`))
    await readAged()
    expect(parses(aged)).toBe(2)
  })
})

describe("readSessionUsageCostSummary", () => {
  it("prices what the records reader found", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("offline", { status: 503 })))

    const summary = await readSessionUsageCostSummary(transcript(`${SESSION}.jsonl`))

    expect(summary).toMatchObject({ sessionId: SESSION, includedFiles: 2, includedSubagents: 1, records: 3 })
    expect(summary?.calls.map((call) => call.isSubagent)).toEqual([false, true, false])
    expect(summary?.totals.outputTokens).toBe(15)
  })
})
