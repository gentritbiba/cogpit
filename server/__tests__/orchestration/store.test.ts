// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest"
import { mkdtempSync, rmSync, statSync } from "node:fs"
import { DatabaseSync } from "node:sqlite"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { OrchestrationStore } from "../../orchestration/store"
import { CommandDispatcher } from "../../orchestration/dispatcher"

const stores: OrchestrationStore[] = []
const roots: string[] = []
function open(path = ":memory:", now?: () => number) { const store = new OrchestrationStore(path, now); stores.push(store); return store }
const binding = { hostId: "local", agent: "codex" as const, instanceId: "default", sessionId: "native-1" }
afterEach(() => { for (const store of stores.splice(0)) store.close(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

describe("durable orchestration", () => {
  it("keeps answer ownership scoped when callers reuse a command ID", () => {
    let time = 1000
    const store = open(":memory:", () => time); const lease = store.acquire("host")!
    const conversation = store.ensureConversation(binding)
    const answerQuestion = { instanceId: "default", sessionId: binding.sessionId, requestId: "scoped-question" }
    const payload = { message: "100", answerQuestion }
    store.putQuestion({ ...answerQuestion, data: { question: "Budget?" } })
    const accepted = store.admitAnswer("alice", "answer-command-001", conversation.id, payload, "default", binding.sessionId, answerQuestion.requestId)
    expect(store.admitAnswer("alice", accepted.id, conversation.id, payload, "default", binding.sessionId, answerQuestion.requestId)).toEqual(accepted)
    expect(() => store.admitAnswer("bob", accepted.id, conversation.id, { ...payload, message: "1000" }, "default", binding.sessionId, answerQuestion.requestId)).toThrow("accepted answer")
    store.admit("bob", accepted.id, conversation.id, payload)
    store.cancel("bob", accepted.id)
    expect(store.questions("default")).toEqual([])
    store.replace("alice", accepted.id, "edited-answer-001", { ...payload, message: "200" })
    expect(store.questions("default")).toEqual([])
    time += 31 * 86400000; store.prunePayloads()
    expect(() => store.admitAnswer("bob", "another-answer-001", conversation.id, payload, "default", binding.sessionId, answerQuestion.requestId)).toThrow("accepted answer")
    store.release(lease)
    store.cancel("alice", "edited-answer-001")
    expect(store.questions("default")).toHaveLength(1)
    expect(store.admitAnswer("bob", "another-answer-001", conversation.id, payload, "default", binding.sessionId, answerQuestion.requestId).state).toBe("queued")
  })

  it("blocks a same-ID turn in another scope until the delivered turn completes", () => {
    const store = open(); const lease = store.acquire("host")!
    const conversation = store.ensureConversation(binding)
    store.admit("alice", "same-command-001", conversation.id, { message: "First" })
    store.admit("bob", "same-command-001", conversation.id, { message: "Second" })
    const first = store.claim("alice", "same-command-001", lease)!
    store.finish(first, lease, "delivered", { delivery: "started" })
    expect(store.claim("bob", "same-command-001", lease)).toBeNull()
    store.finish(first, lease, "completed")
    expect(store.claim("bob", "same-command-001", lease)).not.toBeNull()
  })

  it("keeps a handoff reservation scoped when callers reuse an operation ID", () => {
    const store = open(); const conversation = store.ensureConversation(binding)
    store.beginTransition("alice", "transition-same-command", "hash-a", {}, conversation.id, 1)
    expect(() => store.beginTransition("bob", "transition-same-command", "hash-b", {}, conversation.id, 1)).toThrow("handoff")
    expect(store.operation("bob", "transition-same-command")).toBeNull()
    expect(store.pendingTransition(conversation.id, "bob")).toBeNull()
    expect(() => store.abandonTransition("bob", "transition-same-command", conversation.id)).toThrow("reservation")
    expect(() => store.completeTransition("bob", "transition-same-command", conversation.id, 1, { ...binding, sessionId: "native-2" }, {})).toThrow("reservation")
    expect(store.conversation(conversation.id)?.revision).toBe(1)
    store.abandonTransition("alice", "transition-same-command", conversation.id)
    expect(store.beginTransition("bob", "transition-other-command", "hash-b", {}, conversation.id, 1).fresh).toBe(true)
  })

  it("migrates unique legacy handoff owners and conservatively retains legacy answer links", () => {
    const root = mkdtempSync(join(tmpdir(), "cogpit-legacy-scopes-")); roots.push(root)
    const path = join(root, "state.sqlite")
    const original = open(path); const conversation = original.ensureConversation(binding)
    original.beginTransition("alice", "transition-legacy-one", "hash", { input: { agent: "codex" } }, conversation.id, 1)
    original.putQuestion({ instanceId: "default", sessionId: binding.sessionId, requestId: "legacy-question", data: { question: "Budget?" }, answerCommandId: "legacy-answer-001" })
    original.close(); stores.splice(stores.indexOf(original), 1)
    const old = new DatabaseSync(path)
    old.exec("ALTER TABLE questions DROP COLUMN answer_scope; ALTER TABLE transitions DROP COLUMN scope; PRAGMA user_version=2")
    old.close()
    const migrated = open(path)
    expect(migrated.pendingTransition(conversation.id, "alice")).toMatchObject({ id: "legacy-one" })
    expect(migrated.pendingTransition(conversation.id, "bob")).toBeNull()
    migrated.abandonTransition("alice", "transition-legacy-one", conversation.id)
    expect(migrated.questions("default")).toEqual([])
    expect(() => migrated.admitAnswer("alice", "legacy-answer-001", conversation.id, { message: "100" }, "default", binding.sessionId, "legacy-question")).toThrow("accepted answer")
    const answerQuestion = { instanceId: "default", sessionId: binding.sessionId, requestId: "legacy-question" }
    const lease = migrated.acquire("host")!
    migrated.admit("alice", "legacy-answer-001", conversation.id, { message: "100", answerQuestion })
    migrated.finish(migrated.claim("alice", "legacy-answer-001", lease)!, lease, "unknown")
    migrated.resolveUnknown("alice", "legacy-answer-001", "failed")
    expect(migrated.questions("default")).toHaveLength(1)
  })

  it("keeps ambiguous legacy handoff ownership blocked after migration", () => {
    const root = mkdtempSync(join(tmpdir(), "cogpit-ambiguous-scopes-")); roots.push(root)
    const path = join(root, "state.sqlite")
    const original = open(path); const conversation = original.ensureConversation(binding)
    original.beginTransition("alice", "transition-legacy-same", "hash-a", { input: {} }, conversation.id, 1)
    original.beginOperation("bob", "transition-legacy-same", "hash-b", { input: {} })
    original.close(); stores.splice(stores.indexOf(original), 1)
    const old = new DatabaseSync(path)
    old.exec("ALTER TABLE questions DROP COLUMN answer_scope; ALTER TABLE transitions DROP COLUMN scope; PRAGMA user_version=2")
    old.close()
    const migrated = open(path)
    for (const scope of ["alice", "bob"]) {
      expect(migrated.pendingTransition(conversation.id, scope)).toBeNull()
      expect(() => migrated.beginTransition(scope, "transition-legacy-same", "hash", {}, conversation.id, 1)).toThrow("handoff")
      expect(() => migrated.abandonTransition(scope, "transition-legacy-same", conversation.id)).toThrow("reservation")
    }
  })

  it("fences provider I/O when a lease expires while authorization is awaiting", async () => {
    let time = 1000
    const store = open(":memory:", () => time)
    const dispatcher = new CommandDispatcher(store)
    dispatcher.start()
    const conversation = store.ensureConversation(binding)
    store.admit("owner", "lease-revoked-command", conversation.id, { message: "Go" })
    let release!: (value: boolean) => void
    const authorized = new Promise<boolean>((resolve) => { release = resolve })
    let authorizations = 0
    const deliver = vi.fn(async () => ({ delivery: "started" as const }))
    dispatcher.attach("owner", conversation.id, { authorize: async () => ++authorizations === 1 ? true : authorized, deliver, activity: () => ({ live: false, running: false }) })
    await dispatcher.tick()
    expect(authorizations).toBe(2)
    time += 16000
    expect(store.acquire("replacement")).not.toBeNull()
    release(true)
    await new Promise((resolve) => setTimeout(resolve, 5))
    expect(deliver).not.toHaveBeenCalled()
    expect(store.command("owner", "lease-revoked-command")?.receipt.state).toBe("unknown")
    dispatcher.close()
  })
  it("reopens rejected answers, preserves the edited answer link and deduplicates an explicit resend", () => {
    const store = open(); const lease = store.acquire("host")!
    const conversation = store.ensureConversation(binding)
    const answerQuestion = { instanceId: "default", sessionId: binding.sessionId, requestId: "question-1" }
    store.putQuestion({ ...answerQuestion, data: { question: "Budget?" } })
    store.admitAnswer("owner", "answer-command-1", conversation.id, { message: "100", answerQuestion }, "default", binding.sessionId, "question-1")
    store.replace("owner", "answer-command-1", "answer-command-2", { message: "200", answerQuestion })
    expect(store.questions("default")).toEqual([])
    const claimed = store.claim("owner", "answer-command-2", lease)!
    store.finish(claimed, lease, "failed", { error: "Invalid settings" })
    expect(store.questions("default")).toHaveLength(1)
    store.admitAnswer("owner", "answer-command-3", conversation.id, { message: "300", answerQuestion }, "default", binding.sessionId, "question-1")
    const uncertain = store.claim("owner", "answer-command-3", lease)!
    store.finish(uncertain, lease, "unknown")
    const resend = store.resendUnknown("owner", "answer-command-3", "answer-command-4")
    expect(store.resendUnknown("owner", "answer-command-3", "answer-command-4")).toEqual(resend)
    expect(store.questions("default")).toEqual([])
    expect(store.command("owner", "answer-command-3")?.receipt.state).toBe("failed")
  })

  it("keeps a delivered answer resolved when its subsequent turn fails", () => {
    const store = open(); const lease = store.acquire("host")!
    const conversation = store.ensureConversation(binding)
    const answerQuestion = { instanceId: "default", sessionId: binding.sessionId, requestId: "delivered-question" }
    store.putQuestion({ ...answerQuestion, data: { question: "Budget?" } })
    const payload = { message: "100", answerQuestion }
    store.admitAnswer("owner", "delivered-answer", conversation.id, payload, "default", binding.sessionId, answerQuestion.requestId)
    const claimed = store.claim("owner", "delivered-answer", lease)!
    store.finish(claimed, lease, "delivered", { delivery: "started" })
    store.finish(claimed, lease, "failed", { error: "Next tool failed" })
    expect(store.questions("default")).toEqual([])
    expect(() => store.admitAnswer("owner", "duplicate-answer", conversation.id, payload, "default", binding.sessionId, answerQuestion.requestId)).toThrow("accepted answer")
  })

  it("fences handoffs, persists their native identity and keeps recovery idempotent", () => {
    const store = open(); const lease = store.acquire("host")!
    const conversation = store.ensureConversation(binding)
    store.admit("owner", "before-handoff", conversation.id, { message: "queued" })
    store.beginTransition("owner", "transition-one", "hash", { input: { sessionId: binding.sessionId, agent: "codex" } }, conversation.id, 1)
    expect(store.claim("owner", "before-handoff", lease)).toBeNull()
    expect(() => store.admit("owner", "during-handoff", conversation.id, { message: "go" })).toThrow("handoff")
    store.recordOperationIdentity("owner", "transition-one", "native-2")
    expect(store.pendingTransition(conversation.id, "owner")).toMatchObject({ id: "one", sessionId: "native-2" })
    expect(store.pendingTransition(conversation.id, "other")).toBeNull()
    const completed = store.completeTransition("owner", "transition-one", conversation.id, 1, { ...binding, sessionId: "native-2" }, { mode: "handoff" })
    expect(store.operation("owner", "transition-one")?.result).toEqual(completed)
    expect(store.pendingTransition(conversation.id, "owner")).toBeNull()
    expect(store.command("owner", "before-handoff")?.receipt.state).toBe("held")
    store.forgetSession("native-2")
    expect(store.conversation(conversation.id)?.binding.sessionId).toBe(binding.sessionId)
  })

  it("prunes old content while retaining command fingerprints and never prunes uncertain effects", () => {
    let time = 1000
    const store = open(":memory:", () => time); const lease = store.acquire("host")!
    const conversation = store.ensureConversation(binding)
    store.admit("owner", "completed-one", conversation.id, { message: "private text" })
    store.finish(store.claim("owner", "completed-one", lease)!, lease, "completed")
    store.admit("owner", "uncertain-one", conversation.id, { message: "inspect this" })
    store.finish(store.claim("owner", "uncertain-one", lease)!, lease, "unknown")
    time += 31 * 86400000; store.prunePayloads()
    expect(store.command("owner", "completed-one")?.payload).toEqual({})
    expect(store.admit("owner", "completed-one", conversation.id, { message: "private text" }).state).toBe("completed")
    expect(() => store.admit("owner", "completed-one", conversation.id, { message: "different" })).toThrow("different content")
    expect(store.command("owner", "uncertain-one")?.payload.message).toBe("inspect this")
    expect(store.events(conversation.id, 0).events).toEqual([])
  })
  it("retains questions and scoped immutable receipts across reopen", () => {
    const root = mkdtempSync(join(tmpdir(), "cogpit-store-")); roots.push(root)
    const path = join(root, "private", "state.sqlite")
    const store = open(path)
    const conversation = store.ensureConversation(binding)
    store.putQuestion({ instanceId: "default", sessionId: "native-1", requestId: "q", data: { question: "Budget?" } })
    const payload = { message: "Answer", images: [{ data: "abc", mediaType: "image/png" }] }
    const accepted = store.admitAnswer("owner", "command-001", conversation.id, payload, "default", "native-1", "q")
    expect(store.admitAnswer("owner", "command-001", conversation.id, payload, "default", "native-1", "q")).toEqual(accepted)
    expect(() => store.admit("owner", "command-001", conversation.id, { message: "Changed" })).toThrow("different content")
    expect(store.command("someone-else", "command-001")).toBeNull()
    store.close(); stores.splice(stores.indexOf(store), 1)
    const reopened = open(path)
    expect(reopened.command("owner", "command-001")?.payload).toEqual(payload)
    expect(reopened.questions("default")).toEqual([])
    expect(reopened.ensureConversation(binding).id).toBe(conversation.id)
    if (process.platform !== "win32") { expect(statSync(path).mode & 0o777).toBe(0o600); expect(statSync(join(root, "private")).mode & 0o777).toBe(0o700) }
  })

  it("serializes two hosts, fences stale callbacks and holds recovery work", () => {
    let time = 1000
    const root = mkdtempSync(join(tmpdir(), "cogpit-fence-")); roots.push(root)
    const a = open(join(root, "state.sqlite"), () => time)
    const b = open(join(root, "state.sqlite"), () => time)
    const leaseA = a.acquire("a", 100)!
    const conversation = a.ensureConversation(binding)
    a.admit("owner", "command-001", conversation.id, { message: "one" })
    a.admit("owner", "command-002", conversation.id, { message: "two" })
    expect(b.acquire("b", 100)).toBeNull()
    const claim = a.claim("owner", "command-001", leaseA)!
    expect(b.claim("owner", "command-001", leaseA)).toBeNull()
    expect(a.claim("owner", "command-002", leaseA)).toBeNull()
    time += 101
    const leaseB = b.acquire("b", 100)!
    expect(leaseB.epoch).toBeGreaterThan(leaseA.epoch)
    expect(a.finish(claim, leaseA, "completed")).toBe(false)
    expect(b.command("owner", "command-001")?.receipt.state).toBe("unknown")
    expect(b.command("owner", "command-002")?.receipt.state).toBe("held")
    expect(() => b.resume("owner", conversation.id)).toThrow("uncertain")
    b.resolveUnknown("owner", "command-001", "completed")
    b.resume("owner", conversation.id)
    expect(b.claim("owner", "command-002", leaseB)).not.toBeNull()
  })

  it("replaces immutable messages, reorders with conflict checks and isolates accounts", () => {
    const store = open(); store.acquire("host")
    const conversation = store.ensureConversation(binding)
    const other = store.ensureConversation({ ...binding, instanceId: "another-account" })
    expect(other.id).not.toBe(conversation.id)
    store.admit("owner", "command-001", conversation.id, { message: "one" })
    store.admit("owner", "command-002", conversation.id, { message: "two" })
    const replaced = store.replace("owner", "command-001", "command-003", { message: "edited" })
    expect(replaced.replaces).toBe("command-001")
    expect(store.command("owner", "command-001")?.receipt.state).toBe("cancelled")
    expect(() => store.reorder("owner", conversation.id, ["command-002"])).toThrow("Queue changed")
    store.reorder("owner", conversation.id, ["command-002", "command-003"])
    expect(store.commands(conversation.id, "owner").filter((c) => c.state === "queued").map((c) => c.id)).toEqual(["command-002", "command-003"])
    store.transition(conversation.id, 1, { ...binding, sessionId: "native-2" })
    expect(store.findConversation(binding)?.binding.sessionId).toBe("native-2")
    expect(store.commands(conversation.id, "owner").filter((c) => c.state === "held")).toHaveLength(2)
    store.resume("owner", conversation.id)
    expect(store.commands(conversation.id, "owner").filter((c) => c.state === "held")).toHaveLength(2)
  })

  it("keeps replay cursors scoped and signals future cursor reset", () => {
    const store = open(); store.acquire("host")
    const conversation = store.ensureConversation(binding)
    store.ensureConversation({ ...binding, sessionId: "secret" })
    store.admit("owner", "command-001", conversation.id, { message: "one" })
    const first = store.events(conversation.id, 0, 1)
    expect(first.hasMore).toBe(true)
    expect(store.events(conversation.id, first.cursor).events.every((e) => e.conversationId === conversation.id)).toBe(true)
    expect(store.events(conversation.id, 99999).reset).toBe(true)
  })

  it("retains a task result after a wait timeout and makes acknowledgements idempotent", () => {
    const store = open()
    const task = store.putTask("owner", { sourceId: "delegation-001", parentSessionId: "parent", childSessionId: "child" })
    expect(store.putTask("owner", { sourceId: "delegation-001", parentSessionId: "parent", childSessionId: "child" }).id).toBe(task.id)
    store.updateTask("owner", task.id, { state: "completed", result: { reply: "Done" } })
    store.updateTask("owner", task.id, { acknowledgedAt: 100 })
    expect(store.tasks("owner", "parent")[0]).toMatchObject({ state: "completed", result: { reply: "Done" }, acknowledgedAt: 100 })
    expect(store.tasks("other")).toEqual([])
  })

  it("dispatches once under retries and refuses revoked access before provider I/O", async () => {
    const store = open(); const dispatcher = new CommandDispatcher(store); dispatcher.start()
    const conversation = store.ensureConversation(binding)
    let authorized = true; let deliveries = 0
    dispatcher.attach("owner", conversation.id, { authorize: async () => authorized, deliver: async () => { deliveries++; return { delivery: "started", completion: Promise.resolve({ isError: false }) } }, activity: () => ({ live: false, running: false }) })
    store.admit("owner", "command-001", conversation.id, { message: "one" })
    store.admit("owner", "command-001", conversation.id, { message: "one" })
    await dispatcher.tick()
    await dispatcher.wait("owner", "command-001", 1000)
    expect(deliveries).toBe(1)
    authorized = false
    store.admit("owner", "command-002", conversation.id, { message: "two" })
    await dispatcher.tick()
    expect(store.command("owner", "command-002")?.receipt.state).toBe("held")
    expect(deliveries).toBe(1)
    dispatcher.close()
  })
})
