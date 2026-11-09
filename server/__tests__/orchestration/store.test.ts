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
  it("reads only queued commands in FIFO order on an idle dispatcher tick", () => {
    const store = open()
    const lease = store.acquire("host")!
    const conversation = store.ensureConversation(binding)
    const heldConversation = store.ensureConversation({ ...binding, sessionId: "native-held" })
    const unknownConversation = store.ensureConversation({ ...binding, sessionId: "native-unknown" })
    store.admit("owner", "held-command", heldConversation.id, { message: "held" })
    store.admit("owner", "unknown-command", unknownConversation.id, { message: "unknown" })
    for (const id of ["z-first-queued", "a-second-queued"]) store.admit("owner", id, conversation.id, { message: id })
    const held = store.claim("owner", "held-command", lease)!
    store.finish(held, lease, "held")
    const unknown = store.claim("owner", "unknown-command", lease)!
    store.finish(unknown, lease, "unknown")
    const read = vi.spyOn(store, "command")
    expect(store.queued().map((command) => command.receipt.id)).toEqual(["z-first-queued", "a-second-queued"])
    expect(read.mock.calls.map(([, id]) => id)).toEqual(["z-first-queued", "a-second-queued"])
    expect(store.pending().map((command) => command.receipt.state).sort()).toEqual(["held", "queued", "queued", "unknown"])
  })

  it("cancels what still waits for a stopped session, from every account, and mutes its children's results", () => {
    const store = open()
    const lease = store.acquire("host")!
    const conversation = store.ensureConversation(binding)
    const other = store.ensureConversation({ ...binding, sessionId: "native-other" })
    store.admit("owner", "in-flight-turn", conversation.id, { message: "running" })
    store.claim("owner", "in-flight-turn", lease)
    store.admit("owner", "waiting-message", conversation.id, { message: "later" })
    store.admit("teammate", "waiting-message-too", conversation.id, { message: "also later" })
    store.admit("owner", "parked-message", conversation.id, { message: "held" })
    store.finish(store.claim("owner", "parked-message", lease) ?? store.command("owner", "parked-message")!, lease, "held")
    store.admit("owner", "elsewhere-message", other.id, { message: "another session" })
    expect(store.cancelWaiting(conversation.id)).toBe(3)
    expect(["waiting-message", "parked-message"].map((id) => store.command("owner", id)!.receipt)).toEqual([
      expect.objectContaining({ state: "cancelled", error: "The session was stopped" }),
      expect.objectContaining({ state: "cancelled" }),
    ])
    expect(store.command("teammate", "waiting-message-too")!.receipt.state).toBe("cancelled")
    expect(store.command("owner", "in-flight-turn")!.receipt.state).toBe("dispatching")
    expect(store.command("owner", "elsewhere-message")!.receipt.state).toBe("queued")

    const running = store.putTask("owner", { sourceId: "stopped-parent-1", parentSessionId: "stopped", childSessionId: "helper" })
    const done = store.putTask("teammate", { sourceId: "stopped-parent-2", parentSessionId: "stopped", childSessionId: "helper-2" })
    store.updateTask("teammate", done.id, { state: "completed" })
    const unrelated = store.putTask("owner", { sourceId: "other-parent", parentSessionId: "lead", childSessionId: "stopped" })
    expect(store.muteTasksOf("stopped")).toBe(2)
    expect(store.tasks("owner", "stopped").find((task) => task.id === running.id)).toMatchObject({ state: "running", acknowledgedAt: expect.any(Number) })
    expect(store.tasks("teammate", "stopped")[0]?.acknowledgedAt).toEqual(expect.any(Number))
    expect(store.tasks("owner", "lead").find((task) => task.id === unrelated.id)?.acknowledgedAt).toBeUndefined()
  })

  it("indexes queue polling in existing databases without changing saved commands", () => {
    const root = mkdtempSync(join(tmpdir(), "cogpit-command-index-")); roots.push(root)
    const path = join(root, "state.sqlite")
    const original = new OrchestrationStore(path)
    const conversation = original.ensureConversation(binding)
    original.admit("owner", "saved-command", conversation.id, { message: "keep me" })
    original.putTask("owner", { sourceId: "saved-task", parentSessionId: "parent", childSessionId: "child" })
    original.close()
    const legacy = new DatabaseSync(path)
    legacy.exec("DROP INDEX command_pending; DROP INDEX task_parent; DROP INDEX task_unread")
    legacy.close()
    const reopened = open(path)
    expect(reopened.queued()[0]?.payload).toEqual({ message: "keep me" })
    const db = new DatabaseSync(path)
    try {
      const plan = db.prepare("EXPLAIN QUERY PLAN SELECT scope,id FROM commands WHERE state='queued' ORDER BY position").all()
      expect(plan.map((row) => row.detail).join(" ")).toContain("COVERING INDEX command_pending")
      const tasksPlan = db.prepare("EXPLAIN QUERY PLAN SELECT data FROM tasks WHERE scope=? AND json_extract(data,'$.parentSessionId')=?").all("owner", "parent")
      expect(tasksPlan.map((row) => row.detail).join(" ")).toContain("INDEX task_parent")
      expect(db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'task_%' ORDER BY name").all().map((row) => row.name)).toEqual(["task_parent", "task_unread"])
      const unreadPlan = db.prepare("EXPLAIN QUERY PLAN SELECT data FROM tasks WHERE scope=? AND json_extract(data,'$.parentSessionId')=? AND json_extract(data,'$.acknowledgedAt') IS NULL AND json_extract(data,'$.state')<>'cancelled'").all("owner", "parent")
      expect(unreadPlan.map((row) => row.detail).join(" ")).toContain("INDEX task_unread")
      expect(reopened.tasks("owner", "parent")[0]?.childSessionId).toBe("child")
    } finally { db.close() }
  })

  it("filters task history by parent and owner before loading results", () => {
    const store = open()
    const first = store.putTask("alice", { sourceId: "first-task", parentSessionId: "parent", childSessionId: "first" })
    store.putTask("alice", { sourceId: "other-parent", parentSessionId: "other", childSessionId: "second" })
    store.putTask("bob", { sourceId: "other-owner", parentSessionId: "parent", childSessionId: "third" })
    expect(store.tasks("alice", "parent").map((task) => task.id)).toEqual([first.id])
    expect(store.tasks("alice", "missing")).toEqual([])
    expect(store.tasks("alice")).toHaveLength(2)
    store.updateTask("alice", first.id, { result: { reply: "finished" } })
    expect(store.tasks("alice", "parent")[0]?.result).toEqual({ reply: "finished" })
    expect(() => store.updateTask("bob", first.id, { state: "completed" })).toThrow("Delegated task not found")
  })

  it("reads unread tasks, single tasks and notices without decoding results", () => {
    const store = open()
    const done = store.putTask("alice", { sourceId: "lean-done", parentSessionId: "parent", childSessionId: "a" })
    store.updateTask("alice", done.id, { state: "completed", result: { reply: "x".repeat(1000) }, notified: ["q-1"] })
    const read = store.putTask("alice", { sourceId: "lean-read", parentSessionId: "parent", childSessionId: "a" })
    store.updateTask("alice", read.id, { state: "completed", acknowledgedAt: 42, notified: ["q-2"] })
    store.updateTask("alice", store.putTask("alice", { sourceId: "lean-cancelled", parentSessionId: "parent", childSessionId: "b" }).id, { state: "cancelled" })
    const running = store.putTask("alice", { sourceId: "lean-running", parentSessionId: "other", childSessionId: "b", commandId: "follow-up" })
    store.putTask("bob", { sourceId: "lean-bob", parentSessionId: "parent", childSessionId: "a" })

    const unread = store.unreadTasks("alice", "parent")
    expect(unread.map((task) => task.id)).toEqual([done.id])
    expect(unread[0]).not.toHaveProperty("result")
    expect(unread[0]).toMatchObject({ state: "completed", notified: ["q-1"] })
    expect(store.unreadTasks("alice", "other")[0]).toMatchObject({ id: running.id, commandId: "follow-up" })
    expect(store.taskNotices("alice", "parent", "a").sort()).toEqual(["q-1", "q-2"])
    expect(store.task("alice", done.id)?.result).toEqual({ reply: "x".repeat(1000) })
    expect(store.task("bob", done.id)).toBeNull()
  })

  it("cancels a notice when its agent becomes idle during authorization", async () => {
    const store = open()
    const dispatcher = new CommandDispatcher(store)
    dispatcher.start()
    try {
      const conversation = store.ensureConversation(binding)
      store.admit("owner", "notice-idle-race", conversation.id, { message: "New crew message", onlyWhileRunning: true }, "steer")
      let running = true
      let authorizations = 0
      const deliver = vi.fn(async () => ({ delivery: "started" as const }))
      dispatcher.attach("owner", conversation.id, {
        authorize: async () => { if (++authorizations === 2) running = false; return true },
        activity: () => ({ live: true, running }),
        deliver,
      })
      await dispatcher.tick()
      await vi.waitFor(() => expect(store.command("owner", "notice-idle-race")?.receipt.state).toBe("cancelled"))
      expect(deliver).not.toHaveBeenCalled()
    } finally { dispatcher.close() }
  })

  it("cancels a notice rejected by an idle runtime instead of holding it for a new turn", async () => {
    const store = open()
    const dispatcher = new CommandDispatcher(store)
    dispatcher.start()
    try {
      const conversation = store.ensureConversation(binding)
      store.admit("owner", "notice-runtime-race", conversation.id, { message: "New crew message", onlyWhileRunning: true }, "steer")
      const deliver = vi.fn(async () => ({ delivery: "busy" as const }))
      dispatcher.attach("owner", conversation.id, { authorize: async () => true, activity: () => ({ live: true, running: true }), deliver })
      await dispatcher.tick()
      await vi.waitFor(() => expect(store.command("owner", "notice-runtime-race")?.receipt.state).toBe("cancelled"))
      expect(deliver).toHaveBeenCalledOnce()
    } finally { dispatcher.close() }
  })

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

  it("keeps its own lease, epoch and in-flight work after sleeping past the expiry", () => {
    let time = 1000
    const store = open(":memory:", () => time)
    const lease = store.acquire("host", 100)!
    const conversation = store.ensureConversation(binding)
    store.admit("owner", "slept-delivery", conversation.id, { message: "one" })
    store.admit("owner", "slept-queued", conversation.id, { message: "two" })
    const claimed = store.claim("owner", "slept-delivery", lease)!
    store.finish(claimed, lease, "delivered", { delivery: "started" })
    time += 60_000
    expect(store.acquire("host", 100)).toEqual(lease)
    expect(store.command("owner", "slept-queued")?.receipt.state).toBe("queued")
    expect(store.finish(claimed, lease, "completed")).toBe(true)
  })

  it("completes accepted steers and notifications when another host recovers, but not a turn of its own", () => {
    let time = 1000
    const root = mkdtempSync(join(tmpdir(), "cogpit-recovery-")); roots.push(root)
    const a = open(join(root, "state.sqlite"), () => time)
    const b = open(join(root, "state.sqlite"), () => time)
    const lease = a.acquire("a", 100)!
    const deliver = (id: string, payload: Record<string, unknown>, intent: "queue" | "steer", delivery: "started" | "enqueued", state: "delivered" | "unknown" = "delivered") => {
      const conversation = a.ensureConversation({ ...binding, sessionId: id })
      a.admit("owner", id, conversation.id, payload, intent)
      a.finish(a.claim("owner", id, lease)!, lease, state, { delivery })
    }
    deliver("joined-steer", { message: "also check logs" }, "steer", "enqueued")
    deliver("idle-notice", { message: "crew message", notification: true }, "steer", "started")
    deliver("stale-notice", { message: "crew message", notification: true }, "steer", "enqueued", "unknown")
    deliver("own-turn", { message: "build it" }, "queue", "started")
    time += 101
    b.acquire("b", 100)
    expect(["joined-steer", "idle-notice", "stale-notice", "own-turn"].map((id) => b.command("owner", id)?.receipt.state)).toEqual(["completed", "completed", "completed", "unknown"])
  })

  it("does not fail a message for the failure of the turn it joined", async () => {
    const store = open(); const dispatcher = new CommandDispatcher(store); dispatcher.start()
    try {
      const failedTurn = { isError: true, message: "The agent stopped before completing this turn." }
      for (const [id, intent, delivery] of [["joined-turn", "steer", "enqueued"], ["own-turn", "queue", "started"]] as const) {
        const conversation = store.ensureConversation({ ...binding, sessionId: id })
        dispatcher.attach("owner", conversation.id, { authorize: async () => true, activity: () => ({ live: true, running: false }), deliver: async () => ({ delivery, completion: Promise.resolve(failedTurn) }) })
        store.admit("owner", id, conversation.id, { message: id }, intent)
      }
      await dispatcher.tick()
      expect((await dispatcher.wait("owner", "joined-turn", 1000))?.state).toBe("completed")
      expect((await dispatcher.wait("owner", "own-turn", 1000))?.state).toBe("failed")
    } finally { dispatcher.close() }
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
