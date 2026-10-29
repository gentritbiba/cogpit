// @vitest-environment node
import { afterEach, describe, expect, it } from "vitest"
import { mkdtempSync, rmSync } from "node:fs"
import { DatabaseSync } from "node:sqlite"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { OrchestrationStore, type OccurrenceRecord } from "../../orchestration/store"

const stores: OrchestrationStore[] = []
const roots: string[] = []
afterEach(() => { for (const store of stores.splice(0)) store.close(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

function clock(start = 1_000_000) {
  const state = { now: start }
  return Object.assign(() => state.now, { advance: (ms: number) => { state.now += ms }, state })
}
function open(path = ":memory:", now = clock()) { const store = new OrchestrationStore(path, now); stores.push(store); return store }
function tempPath() { const root = mkdtempSync(join(tmpdir(), "cogpit-triggers-")); roots.push(root); return join(root, "state.sqlite") }
const binding = { hostId: "local", agent: "codex" as const, instanceId: "default", sessionId: "native-1" }
const grant = { grantId: "grant-1", revision: 1 }
function record(overrides: Partial<OccurrenceRecord> = {}): OccurrenceRecord {
  return { triggerId: "trigger-0001", kind: "test", key: "slot-1", dueAt: 1_000_000, action: "session.send", grant, request: { message: "hello" }, ...overrides }
}

describe("orchestration schema version 5", () => {
  it("upgrades a version 4 database in place and refuses one from a newer Cogpit", () => {
    const path = tempPath()
    open(path).close()
    stores.length = 0
    const old = new DatabaseSync(path)
    old.exec("DROP TABLE trigger_occurrences; DROP TABLE trigger_keys; DROP TABLE triggers; DROP TABLE trigger_secrets; DROP TABLE execution_grants; PRAGMA user_version=4")
    old.close()
    const store = open(path)
    expect(store.recordOccurrence("local", record()).outcome).toBe("created")
    store.close(); stores.length = 0
    const check = new DatabaseSync(path)
    expect((check.prepare("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(5)
    check.exec("PRAGMA user_version=6")
    check.close()
    expect(() => new OrchestrationStore(path)).toThrow(/newer Cogpit/)
  })
})

describe("recording occurrences", () => {
  it("returns the first occurrence for a replayed key and refuses different content under it", () => {
    const store = open()
    const first = store.recordOccurrence("local", record())
    expect(first.outcome).toBe("created")
    expect(first.occurrence).toMatchObject({ state: "scheduled", commandId: `trg-${first.occurrence.id}`, creationId: `trgc-${first.occurrence.id}` })
    expect(store.recordOccurrence("local", record())).toMatchObject({ outcome: "duplicate", occurrence: { id: first.occurrence.id } })
    expect(() => store.recordOccurrence("local", record({ request: { message: "other" } }))).toThrow(/different content/)
    // Another account's identical key is its own occurrence.
    expect(store.recordOccurrence("someone", record()).occurrence.id).not.toBe(first.occurrence.id)
  })

  it("coalesces a burst into the waiting occurrence, bounded, and starts another once it is claimed", () => {
    const now = clock()
    const store = open(":memory:", now)
    const lease = store.acquire("host")!
    const burst = (key: string) => store.recordOccurrence("local", record({ key, input: { data: { key } }, coalesce: { windowMs: 60_000, maxInputs: 3 } }))
    const first = burst("delivery-1")
    expect(burst("delivery-2").outcome).toBe("coalesced")
    expect(burst("delivery-2").outcome).toBe("duplicate")
    expect(burst("delivery-3").outcome).toBe("coalesced")
    expect(store.occurrence("local", first.occurrence.id)!.inputs.map((input) => input.key)).toEqual(["delivery-1", "delivery-2", "delivery-3"])
    const full = burst("delivery-4")
    expect(full.outcome).toBe("created")
    expect(store.claimOccurrences(lease, ["test"]).map((claim) => claim.occurrence.id)).toEqual([first.occurrence.id])
    now.advance(120_000)
    expect(burst("delivery-5")).toMatchObject({ outcome: "created" })
  })

  it("refuses a backlog beyond its bound", () => {
    const store = open()
    store.recordOccurrence("local", record({ key: "a", backlog: 2 }))
    store.recordOccurrence("local", record({ key: "b", backlog: 2 }))
    expect(() => store.recordOccurrence("local", record({ key: "c", backlog: 2 }))).toThrow(/already waiting/)
  })
})

describe("claiming occurrences", () => {
  it("claims only due work of handled kinds, one per trigger, and fences writes to the claiming lease", () => {
    const now = clock()
    const store = open(":memory:", now)
    const lease = store.acquire("host")!
    store.recordOccurrence("local", record({ key: "later", dueAt: now() + 1000 }))
    store.recordOccurrence("local", record({ key: "other-kind", kind: "unhandled", triggerId: "trigger-0002" }))
    expect(store.claimOccurrences(lease, ["test"])).toEqual([])
    now.advance(1000)
    store.recordOccurrence("local", record({ key: "now", dueAt: now() }))
    const [claim, ...rest] = store.claimOccurrences(lease, ["test"])
    expect(rest).toEqual([])
    expect(claim!.occurrence.key).toBe("later")
    expect(store.claimOccurrences(lease, ["test"])).toEqual([])
    expect(store.finishOccurrence({ ...claim!, attempt: claim!.attempt + 1 }, lease, "completed")).toBe(false)
    expect(store.finishOccurrence(claim!, lease, "completed")).toBe(true)
    expect(store.claimOccurrences(lease, ["test"]).map((next) => next.occurrence.key)).toEqual(["now"])
  })
})

describe("admitting an occurrence's command", () => {
  it("admits the deterministic command with the occurrence and settles with it", () => {
    const store = open()
    const lease = store.acquire("host")!
    const conversation = store.ensureConversation(binding)
    const { occurrence } = store.recordOccurrence("local", record())
    const [claim] = store.claimOccurrences(lease, ["test"])
    const receipt = store.admitForOccurrence(claim!, lease, conversation.id, { message: "hello" }, "queue")
    expect(receipt).toMatchObject({ id: occurrence.commandId, state: "queued", sessionId: "native-1" })
    expect(store.occurrence("local", occurrence.id)).toMatchObject({ state: "admitted", sessionId: "native-1", command: { id: occurrence.commandId } })
    expect(store.admitForOccurrence(claim!, lease, conversation.id, { message: "hello" }, "queue")).toBeNull()
    const command = store.claim("local", occurrence.commandId, lease)!
    store.finish(command, lease, "completed")
    expect(store.settleAdmittedOccurrences()).toBe(1)
    expect(store.occurrence("local", occurrence.id)).toMatchObject({ state: "completed", finishedAt: expect.any(Number) })
  })

  it("is cancelled by someone messaging the fenced session, before or during its claim, but not by a notification", () => {
    const store = open()
    const lease = store.acquire("host")!
    const conversation = store.ensureConversation(binding)
    const waiting = store.recordOccurrence("local", record({ key: "waiting", fence: { conversationId: conversation.id } })).occurrence
    store.admit("local", "notify-0001", conversation.id, { message: "fyi", notification: true })
    expect(store.occurrence("local", waiting.id)!.state).toBe("scheduled")
    store.admit("local", "manual-0001", conversation.id, { message: "I'll take it from here" })
    expect(store.occurrence("local", waiting.id)).toMatchObject({ state: "cancelled", reason: expect.stringMatching(/messaged/) })

    const racing = store.recordOccurrence("local", record({ key: "racing", fence: { conversationId: conversation.id } })).occurrence
    const [claim] = store.claimOccurrences(lease, ["test"])
    expect(claim!.occurrence.id).toBe(racing.id)
    store.admit("local", "manual-0002", conversation.id, { message: "me again" })
    expect(store.admitForOccurrence(claim!, lease, conversation.id, { message: "continue" }, "queue")).toBeNull()
    expect(store.occurrence("local", racing.id)!.state).toBe("cancelled")
    expect(store.command("local", racing.commandId)).toBeNull()
  })

  it("is held rather than sent when the provider binding moved since it was authorized", () => {
    const store = open()
    const lease = store.acquire("host")!
    const conversation = store.ensureConversation(binding)
    store.transition(conversation.id, conversation.revision, { ...binding, agent: "claude", sessionId: "native-2" })
    const { occurrence } = store.recordOccurrence("local", record())
    const [claim] = store.claimOccurrences(lease, ["test"])
    expect(store.admitForOccurrence(claim!, lease, conversation.id, { message: "continue" }, "queue", conversation.revision)).toBeNull()
    expect(store.occurrence("local", occurrence.id)).toMatchObject({ state: "held", hold: "binding" })
  })

  it("is cancelled when its session stops or is deleted", () => {
    const store = open()
    const conversation = store.ensureConversation(binding)
    const stopped = store.recordOccurrence("local", record({ key: "stopped", fence: { conversationId: conversation.id } })).occurrence
    store.cancelWaiting(conversation.id)
    expect(store.occurrence("local", stopped.id)).toMatchObject({ state: "cancelled", reason: "The session was stopped" })
    const lease = store.acquire("host")!
    store.recordOccurrence("local", record({ key: "deleted" }))
    const [claim] = store.claimOccurrences(lease, ["test"])
    store.admitForOccurrence(claim!, lease, conversation.id, { message: "x" }, "queue")
    store.forgetSession("native-1")
    expect(store.occurrence("local", claim!.occurrence.id)).toMatchObject({ state: "cancelled", reason: "The session was deleted" })
  })
})

describe("a host taking over the lease", () => {
  it("reconciles every boundary another host's claims crashed at", () => {
    const now = clock()
    const path = tempPath()
    const crashed = open(path, now)
    const lease = crashed.acquire("crashed-host")!
    const conversation = crashed.ensureConversation(binding)
    for (const key of ["before-admit", "after-admit", "before-create", "during-create", "after-create"]) crashed.recordOccurrence("local", record({ key, triggerId: `trigger-${key}` }))
    const claims = Object.fromEntries(crashed.claimOccurrences(lease, ["test"]).map((claim) => [claim.occurrence.key, claim]))
    crashed.admitForOccurrence(claims["after-admit"]!, lease, conversation.id, { message: "x" }, "queue")
    for (const key of ["before-create", "during-create", "after-create"]) crashed.beginOccurrenceCreation(claims[key]!, lease)
    crashed.beginOperation("local", claims["during-create"]!.occurrence.creationId, "hash", {})
    crashed.beginOperation("local", claims["after-create"]!.occurrence.creationId, "hash", {})
    crashed.finishOperation("local", claims["after-create"]!.occurrence.creationId, { sessionId: "created-session" })
    // A plain queued command waits for a signed-in user after a restart; one admitted under a grant stays queued.
    crashed.admit("local", "plain-command", conversation.id, { message: "plain" })
    const other = crashed.ensureConversation({ ...binding, sessionId: "native-other" })
    crashed.admit("local", "granted-command", other.id, { message: "granted", executionGrant: grant })
    crashed.close(); stores.length = 0

    now.advance(20_000)
    const takeover = open(path, now)
    expect(takeover.acquire("new-host")!.epoch).toBe(lease.epoch + 1)
    const state = (key: string) => takeover.occurrence("local", claims[key]!.occurrence.id)
    expect(state("before-admit")!.state).toBe("scheduled")
    expect(state("after-admit")).toMatchObject({ state: "admitted", sessionId: "native-1" })
    expect(state("before-create")!.state).toBe("scheduled")
    expect(state("during-create")).toMatchObject({ state: "unknown", reason: expect.stringMatching(/check the project.s sessions/i) })
    expect(state("after-create")).toMatchObject({ state: "completed", sessionId: "created-session" })
    expect(takeover.command("local", "plain-command")!.receipt.state).toBe("held")
    expect(takeover.command("local", "granted-command")!.receipt.state).toBe("queued")
    // The crashed attempt can no longer write.
    expect(takeover.finishOccurrence(claims["before-admit"]!, lease, "completed")).toBe(false)
  })
})

describe("controlling occurrences", () => {
  it("cancels waiting work with its command, refuses delivery in progress, and resolves unknown outcomes", () => {
    const store = open()
    const lease = store.acquire("host")!
    const conversation = store.ensureConversation(binding)
    const scheduled = store.recordOccurrence("local", record({ key: "a" })).occurrence
    expect(store.cancelOccurrence("local", scheduled.id, "Not needed")).toMatchObject({ state: "cancelled", reason: "Not needed" })
    store.recordOccurrence("local", record({ key: "b" }))
    const [claim] = store.claimOccurrences(lease, ["test"])
    expect(() => store.cancelOccurrence("local", claim!.occurrence.id)).toThrow(/being started/)
    store.admitForOccurrence(claim!, lease, conversation.id, { message: "x" }, "queue")
    expect(store.cancelOccurrence("local", claim!.occurrence.id).state).toBe("cancelled")
    expect(store.command("local", claim!.occurrence.commandId)!.receipt.state).toBe("cancelled")

    store.recordOccurrence("local", record({ key: "c" }))
    const [creating] = store.claimOccurrences(lease, ["test"])
    store.beginOccurrenceCreation(creating!, lease)
    store.finishOccurrence(creating!, lease, "unknown", { reason: "?" })
    expect(() => store.cancelOccurrence("local", creating!.occurrence.id)).toThrow(/unknown outcome/)
    expect(store.resolveOccurrence("local", creating!.occurrence.id, "completed", "found-session")).toMatchObject({ state: "completed", sessionId: "found-session" })
  })

  it("holds, requeues under a renewed grant, and skips waiting work", () => {
    const now = clock()
    const store = open(":memory:", now)
    const held = store.recordOccurrence("local", record({ key: "held", dueAt: now() + 5000 })).occurrence
    store.holdOccurrence("local", held.id, "review", "Missed while the host was off")
    expect(store.requeueOccurrence("local", held.id, { grantId: "grant-2", revision: 1 })).toMatchObject({ state: "scheduled", dueAt: now(), grant: { grantId: "grant-2" } })
    expect(store.occurrence("local", held.id)!.hold).toBeUndefined()
    expect(store.skipOccurrence("local", held.id, "Overlaps a running session").state).toBe("skipped")
    expect(() => store.requeueOccurrence("local", held.id)).toThrow(/held/)
  })
})

describe("trigger definitions", () => {
  it("guards edits by revision, reports due ones, keeps secrets apart, and revokes an unused grant on delete", () => {
    const now = clock()
    const store = open(":memory:", now)
    store.putGrant({ id: "grant-1", revision: 1, scope: "local", source: "personal", actions: ["session.create"], target: { agent: "codex", instanceId: "default", dirName: "proj" }, label: "Nightly", createdAt: now(), updatedAt: now() })
    const created = store.putTrigger("local", { id: "task-00001", kind: "test", state: "active", grant, nextDueAt: now() + 1000, data: { name: "Nightly" } })
    expect(() => store.putTrigger("local", { ...created, data: {} })).toThrow(/already exists/)
    expect(() => store.putTrigger("local", { ...created, data: {} }, 7)).toThrow(/changed/)
    expect(store.dueTriggers("test")).toEqual([])
    now.advance(1000)
    expect(store.dueTriggers("test").map((trigger) => trigger.id)).toEqual(["task-00001"])
    expect(store.setTriggerDue("local", "task-00001", created.revision, now() + 60_000)).toBe(true)
    expect(store.setTriggerDue("local", "task-00001", created.revision + 1, null)).toBe(false)
    store.putTriggerSecret("local", "task-00001", "secret-1", { key: "k1" })
    store.putTriggerSecret("local", "task-00001", "secret-2", { key: "k2" })
    store.retireTriggerSecrets("local", "task-00001", "secret-2", 1000)
    expect(store.triggerSecrets("local", "task-00001").map((secret) => secret.id).sort()).toEqual(["secret-1", "secret-2"])
    now.advance(1001)
    expect(store.triggerSecrets("local", "task-00001").map((secret) => secret.id)).toEqual(["secret-2"])
    expect(JSON.stringify(store.trigger("local", "task-00001"))).not.toContain("k2")
    const waiting = store.recordOccurrence("local", record({ triggerId: "task-00001" })).occurrence
    store.deleteTrigger("local", "task-00001")
    expect(store.trigger("local", "task-00001")).toBeNull()
    expect(store.triggerSecrets("local", "task-00001")).toEqual([])
    expect(store.occurrence("local", waiting.id)!.state).toBe("cancelled")
    expect(store.grant("grant-1")).toMatchObject({ revision: 2, revokedAt: now(), revokedReason: "Its task was deleted" })
  })

  it("reports whether the scheduler has work and prunes settled history", () => {
    const now = clock()
    const store = open(":memory:", now)
    expect(store.hasTriggerWork()).toBe(false)
    const { occurrence } = store.recordOccurrence("local", record())
    expect(store.hasTriggerWork()).toBe(true)
    store.cancelOccurrence("local", occurrence.id)
    expect(store.hasTriggerWork()).toBe(false)
    now.advance(31 * 86_400_000)
    store.prunePayloads()
    expect(store.occurrence("local", occurrence.id)).toBeNull()
    expect(store.recordOccurrence("local", record()).outcome).toBe("created")
  })

  it("notifies trigger listeners only after commit", () => {
    const store = open()
    const seen: string[] = []
    store.subscribeTriggers((change) => seen.push(`${change.type}:${change.triggerId}`))
    expect(() => store.recordOccurrence("local", record({ request: { big: "x".repeat(300 * 1024) } }))).toThrow(/too large/)
    store.recordOccurrence("local", record())
    expect(seen).toEqual(["occurrence:trigger-0001"])
  })
})
