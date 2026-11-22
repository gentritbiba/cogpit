// @vitest-environment node
import { mkdtemp, readFile, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { IncomingMessage } from "node:http"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { UsageCostSummary } from "../../../shared/contracts/usageCost"
import type { AgentRuntime } from "../../agents/runtimeTypes"
import {
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
