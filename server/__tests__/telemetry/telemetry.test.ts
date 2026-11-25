// @vitest-environment node
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { IncomingMessage } from "node:http"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { UsageCostSummary } from "../../../shared/contracts/usageCost"
import type { Turn } from "../../../shared/session/types"
import { logAgentFailure } from "../../agents/failureLog"
import type { AgentRuntime } from "../../agents/runtimeTypes"
import {
  __checkTurnsForTest,
  __checkUsageForTest,
  __flushTelemetryForTest,
  recordMessageSent,
  recordSessionStarted,
  recordTelemetry,
  startTelemetry,
  stopTelemetry,
  type TelemetryOptions,
} from "../../telemetry"

const DAY = 24 * 60 * 60 * 1000
const NOW = Date.parse("2026-11-22T12:00:00Z")

interface SentEvent { event: string; timestamp: string; properties: Record<string, unknown> }

let dataDir: string
let now: number
let fetchMock: ReturnType<typeof vi.fn>

function bucket(day: string, model: string, outputTokens: number) {
  return {
    day,
    provider: "codex" as const,
    model,
    totals: { uncachedInputTokens: 100, cachedInputTokens: 50, cacheCreationTokens: 5, cacheCreation1hTokens: 0, outputTokens, reasoningTokens: 3 },
    costUsd: 0.25,
    cacheSavingsUsd: 0,
    costSource: "modelPriced" as const,
    records: 2,
    sessions: 1,
  }
}

function summary(buckets: ReturnType<typeof bucket>[]): UsageCostSummary {
  return {
    sinceDay: "", untilDay: "", timeZone: "UTC", buckets,
    pricing: { status: "fresh", knownModels: 1, fetchedAt: null },
    scannedFiles: 1, distinctSessions: 1, scanDurationMs: 1,
  }
}

async function start(overrides: Partial<TelemetryOptions> = {}) {
  await startTelemetry({
    dataDir,
    shell: "desktop",
    distribution: "desktop",
    edition: "personal",
    freshInstall: true,
    development: false,
    env: {},
    fetch: fetchMock as unknown as typeof fetch,
    readDailyUsage: vi.fn(async () => summary([])),
    now: () => now,
    ...overrides,
  })
}

/** Everything sent so far, oldest first, with the install id of each batch. */
async function sent(): Promise<{ installIds: string[]; events: SentEvent[] }> {
  await __flushTelemetryForTest()
  const bodies = fetchMock.mock.calls.map((call) => JSON.parse(((call as unknown[])[1] as { body: string }).body) as { installId: string; batch: SentEvent[] })
  return { installIds: bodies.map((body) => body.installId), events: bodies.flatMap((body) => body.batch) }
}

const runtime = { kind: "codex", instanceId: "default" } as unknown as AgentRuntime
const browserRequest = { url: "/api/send-message", headers: { "user-agent": "Mozilla/5.0 (X11; Linux x86_64)" } } as unknown as IncomingMessage

async function savedState() {
  return JSON.parse(await readFile(join(dataDir, "telemetry.json"), "utf-8"))
}

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "cogpit-telemetry-"))
  now = NOW
  fetchMock = vi.fn(async () => new Response("{}", { status: 200 }))
})

afterEach(async () => {
  await stopTelemetry()
  await rm(dataDir, { recursive: true, force: true })
})

describe("startTelemetry", () => {
  it("sends a heartbeat with the install id and the common properties", async () => {
    await start()
    const { installIds, events } = await sent()
    expect(installIds).toEqual([(await savedState()).installId])
    expect(events[0]).toMatchObject({ event: "app.heartbeat", properties: { reason: "start", freshInstall: true, shell: "desktop", distribution: "desktop", edition: "personal" } })
    expect(events[0].properties).toMatchObject({ appVersion: expect.any(String), os: expect.any(String), arch: expect.any(String), timezone: expect.any(String) })
    expect(events[0].properties).not.toHaveProperty("hostname")
  })

  it("keeps the same install id across restarts", async () => {
    await start()
    const first = (await savedState()).installId
    await stopTelemetry()
    await start({ freshInstall: false })
    expect((await savedState()).installId).toBe(first)
  })

  it.each([
    [{ COGPIT_TELEMETRY: "0" }, false],
    [{ COGPIT_TELEMETRY: "off" }, false],
    [{ DO_NOT_TRACK: "1" }, false],
    [{ COGPIT_TELEMETRY: "1", DO_NOT_TRACK: "1" }, false],
    [{}, true],
    [{ CI: "true" }, false],
    [{ VITEST: "true" }, false],
  ] as const)("env %o, development %s: sends and writes nothing", async (env, development) => {
    await start({ env, development })
    recordTelemetry("feature.used", { feature: "x", client: "desktop" })
    expect((await sent()).events).toEqual([])
    await expect(stat(join(dataDir, "telemetry.json"))).rejects.toThrow()
  })

  it("lets COGPIT_TELEMETRY=1 send from a development build", async () => {
    await start({ env: { COGPIT_TELEMETRY: "1" }, development: true })
    expect((await sent()).events.map((event) => event.event)).toEqual(["app.heartbeat"])
  })
})

describe("events", () => {
  it("records session starts and messages with public model names only", async () => {
    await start()
    recordSessionStarted(browserRequest, runtime, { dirName: "d", cwd: "/secret/project", model: "gpt-5.5-codex", effort: "high", permissions: { mode: "on-request" }, worktreeName: "w" }, { sessionId: "s1", dirName: "d", fileName: "f", filePath: "/p" })
    recordMessageSent(browserRequest, runtime, "s1", { model: "my-private-finetune", message: "secret prompt" }, { delivery: "started" }, "send-message")
    recordMessageSent(browserRequest, runtime, "s1", {}, { delivery: "busy" }, "send-message")

    const { events } = await sent()
    const [, started, message] = events
    expect(started).toMatchObject({ event: "session.started", properties: { agent: "codex", instance: false, model: "gpt-5.5-codex", effort: "high", permissionMode: "on-request", worktree: true, client: "browser" } })
    expect(message).toMatchObject({ event: "message.sent", properties: { model: "other", delivery: "started", route: "send-message" } })
    expect(events).toHaveLength(3)
    expect(JSON.stringify(events)).not.toMatch(/secret/)
  })

  it("drops property values that are not short tokens", async () => {
    await start()
    recordTelemetry("feature.used", { feature: "/home/someone/private path", client: "desktop" })
    const { events } = await sent()
    expect(events[1].properties).not.toHaveProperty("feature")
  })
})

describe("daily usage", () => {
  it("starts counting from the first day, then reports each finished day once", async () => {
    const readDailyUsage = vi.fn(async (day: string) => summary([bucket(day, "gpt-5.5-codex", 10), bucket(day, "local-llama", 5), bucket(day, "local-other", 1)]))
    await start({ readDailyUsage })
    recordSessionStarted(browserRequest, runtime, { dirName: "d", cwd: "/c" }, { sessionId: "s1", dirName: "d", fileName: "f", filePath: "/p" })

    await __checkUsageForTest()
    expect(readDailyUsage).not.toHaveBeenCalled()
    expect((await savedState()).usageReportedThrough).toBe("2026-11-21")

    now = NOW + DAY
    await __checkUsageForTest()
    expect(readDailyUsage).toHaveBeenCalledWith("2026-11-22", new Set(["s1"]))
    const usage = (await sent()).events.filter((event) => event.event === "usage.daily")
    expect(usage.map((event) => event.properties.model).sort()).toEqual(["gpt-5.5-codex", "other"])
    expect(usage.find((event) => event.properties.model === "other")?.properties).toMatchObject({ outputTokens: 6, responses: 4, inputTokens: 200, costUsd: 0.5 })
    expect(usage[0].timestamp).toBe("2026-11-22T23:59:59.000Z")

    await __checkUsageForTest()
    expect(readDailyUsage).toHaveBeenCalledTimes(1)
  })

  it("advances past days with no Cogpit sessions without reading usage", async () => {
    const readDailyUsage = vi.fn(async () => summary([]))
    await start({ readDailyUsage })
    await __checkUsageForTest()
    now = NOW + 3 * DAY
    await __checkUsageForTest()
    expect(readDailyUsage).not.toHaveBeenCalled()
    expect((await savedState()).usageReportedThrough).toBe("2026-11-24")
  })
})

function turn(timestamp: string, fields: Partial<Turn> = {}): Turn {
  return {
    id: timestamp, userMessage: "secret prompt", contentBlocks: [], thinking: [], assistantText: ["secret reply"],
    toolCalls: [], subAgentActivity: [], timestamp, durationMs: 5_000, model: "claude-opus-5-5",
    tokenUsage: { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 30, cache_creation_input_tokens: 40 },
    ...fields,
  }
}

const at = (offsetMs: number) => new Date(NOW + offsetMs).toISOString()

describe("finished turns", () => {
  it("reports each turn Cogpit drove once it finishes, with its tools", async () => {
    let session = { agent: "claude", mtimeMs: 1, running: true, turns: [turn(at(-60_000)), turn(at(1_000), {
      toolCalls: [
        { id: "a", name: "Bash", input: { command: "cat /secret" }, result: "secret", isError: true, timestamp: at(1_000) },
        { id: "b", name: "Edit", input: {}, result: null, isError: false, timestamp: at(1_000), diffLineCounts: { add: 3, del: 1 } },
        { id: "c", name: "mcp__private__thing", input: {}, result: null, isError: false, timestamp: at(1_000) },
      ],
    }), turn(at(2_000))] }
    const readSessionTurns = vi.fn(async (_id: string, known: number | undefined) => known === session.mtimeMs ? null : session)
    await start({ readSessionTurns })
    recordSessionStarted(browserRequest, runtime, { dirName: "d", cwd: "/c" }, { sessionId: "s1", dirName: "d", fileName: "f", filePath: "/p" })

    await __checkTurnsForTest()
    let events = (await sent()).events.filter((event) => event.event === "turn.completed" || event.event === "tool.used")
    expect(events.map((event) => event.event)).toEqual(["turn.completed", "tool.used", "tool.used", "tool.used"])
    expect(events[0]).toMatchObject({ timestamp: at(1_000), properties: { agent: "claude", model: "claude-opus-5-5", durationMs: 5_000, inputTokens: 10, outputTokens: 20, cacheReadTokens: 30, cacheWriteTokens: 40, toolCalls: 3, toolErrors: 1, linesAdded: 3, linesRemoved: 1, mcp: true } })
    expect(events.slice(1).map((event) => event.properties)).toEqual([
      expect.objectContaining({ tool: "Bash", calls: 1, errors: 1 }),
      expect.objectContaining({ tool: "Edit", calls: 1, errors: 0 }),
      expect.objectContaining({ tool: "mcp", calls: 1, errors: 0 }),
    ])
    expect(JSON.stringify(events)).not.toMatch(/secret|private/)

    fetchMock.mockClear()
    await __checkTurnsForTest()
    expect(readSessionTurns).toHaveBeenLastCalledWith("s1", 1)
    expect((await sent()).events.filter((event) => event.event === "turn.completed")).toEqual([])

    session = { ...session, mtimeMs: 2, running: false }
    await __checkTurnsForTest()
    events = (await sent()).events.filter((event) => event.event === "turn.completed")
    expect(events.map((event) => event.timestamp)).toEqual([at(2_000)])
    await stopTelemetry()
    expect((await savedState()).turns.s1).toBe(NOW + 2_000)
  })

  it("does not report turns of a session noted before turns were counted", async () => {
    const readSessionTurns = vi.fn(async () => ({ agent: "codex", mtimeMs: 1, running: false, turns: [turn(at(-1_000))] }))
    await start({ readSessionTurns })
    recordSessionStarted(browserRequest, runtime, { dirName: "d", cwd: "/c" }, { sessionId: "s1", dirName: "d", fileName: "f", filePath: "/p" })
    await stopTelemetry()
    const state = await savedState()
    delete state.turns
    await writeFile(join(dataDir, "telemetry.json"), JSON.stringify(state))

    await start({ readSessionTurns })
    await __checkTurnsForTest()
    expect(readSessionTurns).not.toHaveBeenCalled()
    expect((await sent()).events.filter((event) => event.event === "turn.completed")).toEqual([])
  })
})

describe("agents", () => {
  it("reports each agent's status", async () => {
    await start({ readAgentStatus: async () => [{ agent: "codex", installed: true, signedIn: "unknown", version: "0.200.1" }] })
    await __checkTurnsForTest()
    const status = (await sent()).events.find((event) => event.event === "agent.status")
    expect(status?.properties).toMatchObject({ agent: "codex", installed: true, signedIn: "unknown", version: "0.200.1" })
  })

  it("records a failed turn by its category, never its message", async () => {
    await start()
    vi.spyOn(console, "warn").mockImplementation(() => {})
    logAgentFailure("turn", { sessionId: "s1", kind: "codex", message: "secret: 401 Unauthorized", httpStatus: 401 })
    const failure = (await sent()).events.find((event) => event.event === "agent.error")
    expect(failure?.properties).toMatchObject({ agent: "codex", phase: "turn", reason: "not_signed_in", httpStatus: 401 })
    expect(JSON.stringify(failure)).not.toMatch(/secret/)
  })
})
