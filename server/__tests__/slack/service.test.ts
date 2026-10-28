// @vitest-environment node
import { mkdir, mkdtemp, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { SlackService, successorOf, type SlackConnection, type SlackServiceDeps, type TurnEnd } from "../../slack/service"
import { SlackStore } from "../../slack/store"

const OWNER = "U01TRP22K28"
const BOT_USER = "U0BK06BR2AK"
const DM = "D0BK06FJKHD"
const BOT_TOKEN = "xoxb-test-secret"
const APP_TOKEN = "xapp-test-secret"

let dir: string
let services: SlackService[]

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "cogpit-slack-"))
  services = []
})
afterEach(async () => {
  for (const service of services) await service.stop()
  await rm(dir, { recursive: true, force: true })
})

interface Harness {
  service: SlackService
  store: SlackStore
  calls: Array<{ method: string; body: Record<string, unknown> }>
  delivered: Array<{ sessionId: string; text: string; commandId: string }>
  deliver: ReturnType<typeof vi.fn>
  endTurn: (result: TurnEnd) => void
  turnEnded: ReturnType<typeof vi.fn>
  connections: SlackConnection[]
}

function harness(overrides: Partial<SlackServiceDeps> = {}): Harness {
  const store = new SlackStore(dir)
  const calls: Harness["calls"] = []
  const delivered: Harness["delivered"] = []
  const connections: SlackConnection[] = []
  let ends: Array<(value: TurnEnd) => void> = []
  let posted = 0
  const deliver = vi.fn(async (sessionId: string, text: string, commandId: string): Promise<{ commandId: string; uncertain?: boolean }> => {
    delivered.push({ sessionId, text, commandId })
    return { commandId }
  })
  const turnEnded = vi.fn(() => new Promise<TurnEnd>((resolve) => { ends.push(resolve) }))
  const service = new SlackService({
    store,
    api: () => async (method, body = {}) => {
      calls.push({ method, body })
      if (method === "auth.test") return { ok: true, user_id: BOT_USER, team_id: "T1", team: "Honest Digital" }
      if (method === "conversations.open") return { ok: true, channel: { id: DM } }
      if (method === "chat.postMessage") return { ok: true, ts: `900.${++posted}` }
      return { ok: true }
    },
    connect: () => {
      const connection: SlackConnection = { state: "connected", start: vi.fn(), stop: vi.fn() }
      connections.push(connection)
      return connection
    },
    deliver,
    sessionExists: async (id) => id.startsWith("s"),
    turnEnded,
    log: () => {},
    retryMs: 20,
    ...overrides,
  })
  services.push(service)
  return {
    service, store, calls, delivered, deliver, connections, turnEnded,
    endTurn: (result) => { const pending = ends; ends = []; for (const end of pending) end(result) },
  }
}

async function linked(h: Harness, options: { autoPost?: boolean; channels?: string[] } = {}) {
  await h.service.start()
  await h.service.addBot("odyssey", BOT_TOKEN, APP_TOKEN)
  return h.service.link({ sessionId: "s1", bot: "odyssey", ...options })
}

const dmEvent = (ts: string, overrides: Record<string, unknown> = {}) => ({ event_id: `Ev${ts}`, event: { type: "message", channel: DM, channel_type: "im", user: OWNER, text: `message ${ts}`, ts, ...overrides } })
const settle = async (h: Harness) => { await h.service.pump(); await new Promise((resolve) => setTimeout(resolve, 5)) }

describe("SlackService", () => {
  it("links the owner's DM by default and keeps tokens in owner-only files", async () => {
    const h = harness()
    const link = await linked(h)
    expect(link).toMatchObject({ allow: [OWNER], dms: [DM], channels: [], autoPost: false, dailyCap: 20 })
    expect(h.connections).toHaveLength(1)
    if (process.platform !== "win32") {
      expect((await stat(join(dir, "bots.json"))).mode & 0o777).toBe(0o600)
      expect((await stat(join(dir, "state.json"))).mode & 0o777).toBe(0o600)
      expect((await stat(dir)).mode & 0o777).toBe(0o700)
    }
    const shown = JSON.stringify(await h.service.status())
    expect(shown).not.toContain(BOT_TOKEN)
    expect(shown).not.toContain(APP_TOKEN)
  })

  it("refuses to link a bot to a second session, or a session on another machine", async () => {
    const h = harness()
    await linked(h)
    await expect(h.service.link({ sessionId: "s2", bot: "odyssey" })).rejects.toThrow("already linked to session s1")
    await expect(h.service.link({ sessionId: "remote-1", bot: "odyssey" })).rejects.toThrow("not on this machine")
  })

  it("writes a message to disk before acknowledging it, then steers it into the session once", async () => {
    const h = harness()
    await linked(h)
    await h.service.receive("odyssey", dmEvent("100.1"))
    expect((await new SlackStore(dir).read()).inbox).toMatchObject([{ key: `T1:${DM}:100.1`, threadTs: "100.1" }])
    await h.service.receive("odyssey", dmEvent("100.1"))
    await h.service.receive("odyssey", { ...dmEvent("100.1"), event_id: "EvOther" })
    await settle(h)
    expect(h.delivered).toHaveLength(1)
    expect(h.delivered[0]).toMatchObject({ sessionId: "s1", commandId: expect.stringMatching(/^slack-[a-f0-9]{32}$/) })
    expect(h.delivered[0].text).toContain("slack reply --thread 100.1")
    expect(h.calls.find((call) => call.method === "assistant.threads.setStatus")?.body).toEqual({ channel_id: DM, thread_ts: "100.1", status: "is thinking…" })
  })

  it("ignores people not on the allowlist and says so in status", async () => {
    const h = harness()
    await linked(h)
    await h.service.receive("odyssey", dmEvent("100.2", { user: "U0STRANGER" }))
    await settle(h)
    expect(h.delivered).toHaveLength(0)
    const [link] = (await h.service.status("s1")).links
    expect(link.recentlyIgnored).toMatchObject([{ reason: "user not on the allowlist", user: "U0STRANGER" }])
  })

  it("keeps a message that could not be delivered and retries it, in order", async () => {
    let fail = true
    const h = harness()
    h.deliver.mockImplementation(async (sessionId: string, text: string, commandId: string) => {
      if (fail) throw new Error("session restarting")
      h.delivered.push({ sessionId, text, commandId })
      return { commandId }
    })
    await linked(h)
    await h.service.receive("odyssey", dmEvent("100.1"))
    await h.service.receive("odyssey", dmEvent("100.2"))
    await settle(h)
    // Each arrival retries what is waiting, but nothing overtakes the message that failed.
    expect(h.deliver.mock.calls.every(([, text]) => String(text).includes("ts 100.1)"))).toBe(true)
    expect((await h.service.status("s1")).links[0].pending).toMatchObject([{ lastError: "session restarting" }, { attempts: 0 }])
    fail = false
    await vi.waitFor(() => expect(h.delivered.map((entry) => entry.text.match(/ts (\S+)\)/)?.[1])).toEqual(["100.1", "100.2"]))
  })

  it("delivers what was queued before a restart", async () => {
    const first = harness({ deliver: vi.fn(async () => { throw new Error("down") }) })
    await linked(first)
    await first.service.receive("odyssey", dmEvent("100.1"))
    await settle(first)
    await first.service.stop()
    const second = harness()
    await second.service.start()
    await settle(second)
    expect(second.delivered).toHaveLength(1)
  })

  it("posts replies only to the link's DMs and listed channels", async () => {
    const h = harness()
    await linked(h)
    await h.service.receive("odyssey", dmEvent("100.1"))
    expect(await h.service.reply("s1", { threadTs: "100.1", text: "**done**" })).toMatchObject({ posted: true, channel: DM, threadTs: "100.1" })
    expect(h.calls.find((call) => call.method === "chat.postMessage")?.body).toMatchObject({ channel: DM, thread_ts: "100.1", text: "*done*", mrkdwn: true })
    await expect(h.service.reply("s1", { channel: "C0GENERAL", text: "hello all" })).rejects.toThrow("may not post to C0GENERAL")
    expect(await h.service.reply("s1", { threadTs: "100.1", text: "**done**" })).toMatchObject({ posted: false, note: expect.stringContaining("30 minutes") })
    await expect(h.service.reply("s2", { text: "x" })).rejects.toThrow("not linked")
  })

  it("delivers mentions in channels it may not post to, pointing replies at the DM", async () => {
    const h = harness()
    await linked(h)
    await h.service.receive("odyssey", { event_id: "Ev1", event: { type: "app_mention", channel: "C0GENERAL", user: OWNER, text: `<@${BOT_USER}> look`, ts: "200.1" } })
    await settle(h)
    expect(h.delivered[0].text).toContain("cannot post there")
  })

  it("posts the turn's final answer when auto-post is on, and clears the thread status", async () => {
    const h = harness()
    await linked(h, { autoPost: true })
    await h.service.receive("odyssey", dmEvent("100.1"))
    await settle(h)
    h.endTurn({ reply: "All **green**" })
    await vi.waitFor(() => expect(h.calls.filter((call) => call.method === "chat.postMessage").map((call) => call.body)).toEqual([expect.objectContaining({ channel: DM, thread_ts: "100.1", text: "All *green*" })]))
    await vi.waitFor(() => expect(h.calls.filter((call) => call.method === "assistant.threads.setStatus").map((call) => call.body.status)).toEqual(["is thinking…", ""]))
  })

  it("skips the automatic post when the session already answered in that thread", async () => {
    const h = harness()
    await linked(h, { autoPost: true })
    await h.service.receive("odyssey", dmEvent("100.1"))
    await settle(h)
    await h.service.reply("s1", { threadTs: "100.1", text: "answered by hand" })
    h.endTurn({ reply: "final answer" })
    await vi.waitFor(async () => expect((await h.store.read()).inbox[0].awaitingTurn).toBeUndefined())
    expect(h.calls.filter((call) => call.method === "chat.postMessage")).toHaveLength(1)
  })

  it("unlinking drops what was not delivered and closes the connection", async () => {
    const h = harness({ deliver: vi.fn(async () => { throw new Error("down") }) })
    await linked(h)
    await h.service.receive("odyssey", dmEvent("100.1"))
    expect(await h.service.unlink("s1")).toEqual({ unlinked: true, droppedPending: 1 })
    expect(h.connections[0].stop).toHaveBeenCalled()
    expect((await h.service.status()).links).toEqual([])
  })

  it("looks for the answer to this message, not just the session's last turn", async () => {
    const h = harness()
    await linked(h, { autoPost: true })
    await h.service.receive("odyssey", dmEvent("100.1"))
    await settle(h)
    expect(h.turnEnded).toHaveBeenCalledWith("s1", h.delivered[0].commandId, h.delivered[0].text.split("\n")[0], expect.any(AbortSignal))
  })

  it("after a restart, re-checks messages whose turn had not ended and keeps the id that now carries them", async () => {
    const first = harness()
    await linked(first)
    await first.service.receive("odyssey", dmEvent("100.1"))
    await settle(first)
    const original = first.delivered[0].commandId
    await first.service.stop()
    const second = harness()
    second.deliver.mockImplementation(async (_sessionId: string, _text: string, commandId: string) => ({ commandId: `${commandId}-rheld1` }))
    await second.service.start()
    await settle(second)
    expect(second.deliver).toHaveBeenCalledWith("s1", expect.any(String), original)
    expect((await second.store.read()).inbox[0]).toMatchObject({ status: "admitted", commandId: `${original}-rheld1`, awaitingTurn: true })
    expect(second.turnEnded).toHaveBeenCalledWith("s1", `${original}-rheld1`, expect.any(String), expect.any(AbortSignal))
  })

  it("shows a delivery a restart left uncertain instead of watching it", async () => {
    const h = harness()
    h.deliver.mockImplementation(async (_sessionId: string, _text: string, commandId: string) => ({ commandId, uncertain: true }))
    await linked(h)
    await h.service.receive("odyssey", dmEvent("100.1"))
    await settle(h)
    expect(h.turnEnded).not.toHaveBeenCalled()
    expect((await h.service.status("s1")).links[0].uncertain).toMatchObject([{ lastError: expect.stringContaining("may or may not have arrived") }])
  })

  it("puts a message the queue held back into the inbox to be released", async () => {
    const h = harness()
    await linked(h)
    await h.service.receive("odyssey", dmEvent("100.1"))
    await settle(h)
    h.endTurn({ held: true })
    await vi.waitFor(() => expect(h.deliver).toHaveBeenCalledTimes(2))
  })

  it("leaves memory unchanged when a write fails, so Slack's resend is delivered", async () => {
    const h = harness()
    await linked(h)
    await rm(join(dir, "state.json"))
    await mkdir(join(dir, "state.json", "blocker"), { recursive: true })
    await expect(h.service.receive("odyssey", dmEvent("100.1"))).rejects.toThrow()
    expect((await h.store.read()).inbox).toEqual([])
    await rm(join(dir, "state.json"), { recursive: true })
    await h.service.receive("odyssey", dmEvent("100.1"))
    await settle(h)
    expect(h.delivered).toHaveLength(1)
  })

  it("counts every chunk of a long reply against the daily cap", async () => {
    const h = harness()
    await h.service.start()
    await h.service.addBot("odyssey", BOT_TOKEN, APP_TOKEN)
    await h.service.link({ sessionId: "s1", bot: "odyssey", dailyCap: 2 })
    const long = Array.from({ length: 30 }, (_, i) => `Paragraph ${i} ${"x".repeat(300)}`).join("\n\n")
    await expect(h.service.reply("s1", { text: long })).rejects.toThrow("this reply needs 3, 2 left")
    expect(h.calls.filter((call) => call.method === "chat.postMessage")).toHaveLength(0)
    await h.service.reply("s1", { text: "short" })
    expect((await h.service.status("s1")).links[0].postedToday).toBe(1)
  })

  it("keeps reservations only for the chunks that went out", async () => {
    let sent = 0
    const h = harness({ api: () => async (method) => {
      if (method === "auth.test") return { ok: true, user_id: BOT_USER, team_id: "T1" }
      if (method === "conversations.open") return { ok: true, channel: { id: DM } }
      if (method === "chat.postMessage" && ++sent === 2) throw new Error("ratelimited")
      return { ok: true, ts: `900.${sent}` }
    } })
    await linked(h)
    const long = Array.from({ length: 30 }, (_, i) => `Paragraph ${i} ${"x".repeat(300)}`).join("\n\n")
    await expect(h.service.reply("s1", { text: long })).rejects.toThrow("ratelimited")
    expect((await h.store.read()).sent.map((record) => record.ts)).toEqual(["900.1"])
  })

  it("records a delivery that turned uncertain while its turn was watched", async () => {
    const h = harness()
    await linked(h)
    await h.service.receive("odyssey", dmEvent("100.1"))
    await settle(h)
    h.endTurn({ uncertain: true })
    await vi.waitFor(async () => expect((await h.service.status("s1")).links[0]).toMatchObject({ awaitingTurn: 0, uncertain: [{ lastError: expect.stringContaining("may or may not have arrived") }] }))
  })

  it("does not deliver what an unlink dropped while a delivery was under way", async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const h = harness()
    h.deliver.mockImplementation(async (sessionId: string, text: string, commandId: string) => {
      await gate
      h.delivered.push({ sessionId, text, commandId })
      return { commandId }
    })
    await linked(h)
    await h.service.receive("odyssey", dmEvent("100.1"))
    await h.service.receive("odyssey", dmEvent("100.2"))
    expect(await h.service.unlink("s1")).toMatchObject({ unlinked: true })
    release()
    await settle(h)
    expect(h.delivered.map((entry) => entry.text.match(/ts (\S+)\)/)?.[1])).toEqual(["100.1"])
  })
})

describe("successorOf", () => {
  it("numbers releases so the same one is found again", () => {
    expect(successorOf("slack-abc")).toBe("slack-abc-r1")
    expect(successorOf("slack-abc-r1")).toBe("slack-abc-r2")
  })
})
