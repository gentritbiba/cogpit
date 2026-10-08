import { createHash, randomUUID } from "node:crypto"
import { chmodSync, existsSync, mkdirSync } from "node:fs"
import { dirname } from "node:path"
import { openDatabase, type SqliteDatabase } from "./database"
import type { CommandIntent, CommandReceipt, CommandState, Conversation, ConversationEvent, DelegatedTask, EventPage, NativeBinding, ProviderInstance } from "../../shared/contracts/orchestration"

type Row = Record<string, unknown>
export interface StoredCommand {
  receipt: CommandReceipt
  scope: string
  payload: Record<string, unknown>
  fingerprint: string
  attempt: number
  epoch: number
}
export interface DispatcherLease { owner: string; epoch: number }
export interface StoredQuestion { sessionId: string; requestId: string; instanceId: string; data: unknown; answerCommandId?: string }

export class OrchestrationError extends Error {
  constructor(readonly status: number, message: string) { super(message); this.name = "OrchestrationError" }
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical)
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, canonical(v)]))
  return value
}
export function fingerprint(value: unknown): string { return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex") }
function decode<T>(value: unknown): T { return JSON.parse(String(value)) as T }
function receipt(row: Row): CommandReceipt {
  return { ...decode<CommandReceipt>(row.receipt), state: row.state as CommandState, position: Number(row.position), updatedAt: Number(row.updated_at) }
}

export class OrchestrationStore {
  private readonly db: SqliteDatabase
  private readonly listeners = new Set<(event: ConversationEvent) => void>()
  private pendingEvents: ConversationEvent[] | null = null

  constructor(readonly path: string, private readonly now: () => number = Date.now) {
    if (path !== ":memory:") {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
      if (process.platform !== "win32") chmodSync(dirname(path), 0o700)
    }
    this.db = openDatabase(path)
    try {
      this.db.exec("PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;")
      const version = Number((this.db.prepare("PRAGMA user_version").get() as Row).user_version)
      if (version > 3) throw new Error("Orchestration database was created by a newer Cogpit; upgrade before opening it")
      this.transaction(() => {
        this.db.exec(`
          CREATE TABLE IF NOT EXISTS conversations(id TEXT PRIMARY KEY, native_key TEXT UNIQUE NOT NULL, data TEXT NOT NULL);
          CREATE TABLE IF NOT EXISTS bindings(native_key TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id), data TEXT NOT NULL);
          CREATE TABLE IF NOT EXISTS commands(scope TEXT NOT NULL, id TEXT NOT NULL, conversation_id TEXT NOT NULL REFERENCES conversations(id), fingerprint TEXT NOT NULL, payload TEXT NOT NULL, receipt TEXT NOT NULL, state TEXT NOT NULL, position INTEGER NOT NULL, attempt INTEGER NOT NULL DEFAULT 0, epoch INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL, PRIMARY KEY(scope,id));
          CREATE INDEX IF NOT EXISTS command_queue ON commands(conversation_id,position,state);
          CREATE TABLE IF NOT EXISTS questions(instance_id TEXT NOT NULL, session_id TEXT NOT NULL, request_id TEXT NOT NULL, data TEXT NOT NULL, answer_command_id TEXT, PRIMARY KEY(instance_id,session_id,request_id));
          CREATE TABLE IF NOT EXISTS events(sequence INTEGER PRIMARY KEY AUTOINCREMENT, conversation_id TEXT NOT NULL, type TEXT NOT NULL, created_at INTEGER NOT NULL, data TEXT NOT NULL);
          CREATE INDEX IF NOT EXISTS event_conversation ON events(conversation_id,sequence);
          CREATE TABLE IF NOT EXISTS dispatcher(id INTEGER PRIMARY KEY CHECK(id=1), owner TEXT NOT NULL, epoch INTEGER NOT NULL, expires_at INTEGER NOT NULL);
          CREATE TABLE IF NOT EXISTS tasks(id TEXT PRIMARY KEY, scope TEXT NOT NULL, source_id TEXT NOT NULL, data TEXT NOT NULL, UNIQUE(scope,source_id));
          CREATE TABLE IF NOT EXISTS instances(id TEXT PRIMARY KEY, data TEXT NOT NULL);
          CREATE TABLE IF NOT EXISTS transitions(conversation_id TEXT PRIMARY KEY, operation_id TEXT NOT NULL);
          CREATE TABLE IF NOT EXISTS operations(scope TEXT NOT NULL,id TEXT NOT NULL,fingerprint TEXT NOT NULL,input TEXT NOT NULL,result TEXT,PRIMARY KEY(scope,id));
        `)
        if (!(this.db.prepare("PRAGMA table_info(events)").all() as Row[]).some((row) => row.name === "scope")) this.db.exec("ALTER TABLE events ADD COLUMN scope TEXT")
        if (!(this.db.prepare("PRAGMA table_info(operations)").all() as Row[]).some((row) => row.name === "updated_at")) this.db.exec("ALTER TABLE operations ADD COLUMN updated_at INTEGER NOT NULL DEFAULT 0")
        if (!(this.db.prepare("PRAGMA table_info(questions)").all() as Row[]).some((row) => row.name === "answer_scope")) this.db.exec("ALTER TABLE questions ADD COLUMN answer_scope TEXT")
        if (!(this.db.prepare("PRAGMA table_info(transitions)").all() as Row[]).some((row) => row.name === "scope")) {
          this.db.exec("ALTER TABLE transitions ADD COLUMN scope TEXT")
          this.db.exec("UPDATE transitions SET scope=(SELECT scope FROM operations WHERE id=transitions.operation_id) WHERE (SELECT COUNT(*) FROM operations WHERE id=transitions.operation_id)=1")
        }
        this.db.exec("PRAGMA user_version=3")
      })
      this.protectFiles()
    } catch (error) { this.db.close(); throw error }
  }

  private protectFiles(): void {
    if (this.path === ":memory:" || process.platform === "win32") return
    for (const file of [this.path, `${this.path}-wal`, `${this.path}-shm`]) if (existsSync(file)) chmodSync(file, 0o600)
  }

  private transaction<T>(operation: () => T): T {
    if (this.pendingEvents) return operation()
    this.db.exec("BEGIN IMMEDIATE")
    this.pendingEvents = []
    let result: T
    let events: ConversationEvent[]
    try {
      result = operation()
      this.db.exec("COMMIT")
      events = this.pendingEvents
    } catch (error) { this.db.exec("ROLLBACK"); throw error }
    finally { this.pendingEvents = null }
    this.protectFiles()
    for (const event of events) for (const listener of this.listeners) {
      try { listener(event) } catch { /* Committed state remains available through replay. */ }
    }
    return result
  }

  close(): void { this.listeners.clear(); this.db.close() }
  subscribe(listener: (event: ConversationEvent) => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener) }
  private event(conversationId: string, type: ConversationEvent["type"], data: unknown, scope?: string): void {
    const createdAt = this.now()
    const insert = this.db.prepare("INSERT INTO events(conversation_id,type,created_at,data,scope) VALUES(?,?,?,?,?)").run(conversationId, type, createdAt, JSON.stringify(data), scope ?? null)
    this.pendingEvents?.push({ sequence: Number(insert.lastInsertRowid), conversationId, type, createdAt, data })
    this.db.prepare("DELETE FROM events WHERE sequence <= (SELECT COALESCE(MAX(sequence),0)-10000 FROM events)").run()
  }
  private nativeKey(binding: NativeBinding): string { return JSON.stringify([binding.hostId, binding.agent, binding.instanceId, binding.nativeSessionId ?? binding.sessionId]) }

  ensureConversation(binding: NativeBinding): Conversation {
    return this.transaction(() => {
      const key = this.nativeKey(binding)
      const found = this.db.prepare("SELECT conversation_id FROM bindings WHERE native_key=?").get(key) as Row | undefined
      if (found) return this.conversation(String(found.conversation_id))!
      const id = `conversation-${fingerprint(key).slice(0, 32)}`
      const conversation: Conversation = { id, revision: 1, binding, createdAt: this.now(), updatedAt: this.now() }
      this.db.prepare("INSERT INTO conversations VALUES(?,?,?)").run(id, key, JSON.stringify(conversation))
      this.db.prepare("INSERT INTO bindings VALUES(?,?,?)").run(key, id, JSON.stringify(binding))
      this.event(id, "binding", conversation)
      return conversation
    })
  }
  conversation(id: string): Conversation | null {
    const row = this.db.prepare("SELECT data FROM conversations WHERE id=?").get(id) as Row | undefined
    return row ? decode<Conversation>(row.data) : null
  }
  findConversation(binding: NativeBinding): Conversation | null {
    const row = this.db.prepare("SELECT conversation_id FROM bindings WHERE native_key=?").get(this.nativeKey(binding)) as Row | undefined
    return row ? this.conversation(String(row.conversation_id)) : null
  }
  transition(id: string, expectedRevision: number, binding: NativeBinding): Conversation {
    return this.transaction(() => {
      const current = this.conversation(id)
      if (!current) throw new OrchestrationError(404, "Conversation not found")
      if (current.revision !== expectedRevision) throw new OrchestrationError(409, "Conversation changed; refresh before switching")
      if (this.db.prepare("SELECT 1 FROM commands WHERE conversation_id=? AND state IN ('dispatching','delivered','unknown')").get(id)) throw new OrchestrationError(409, "Resolve the active or uncertain delivery before switching")
      const key = this.nativeKey(binding)
      const existing = this.findConversation(binding)
      if (existing && existing.id !== id) throw new OrchestrationError(409, "Native session already belongs to another conversation")
      const updated = { ...current, binding, revision: current.revision + 1, updatedAt: this.now() }
      this.db.prepare("INSERT OR IGNORE INTO bindings VALUES(?,?,?)").run(key, id, JSON.stringify(binding))
      this.db.prepare("UPDATE conversations SET native_key=?,data=? WHERE id=?").run(key, JSON.stringify(updated), id)
      this.db.prepare("UPDATE commands SET state='held',updated_at=? WHERE conversation_id=? AND state='queued'").run(this.now(), id)
      this.event(id, "binding", updated)
      return updated
    })
  }

  private reserveTransition(scope: string, id: string, revision: number, operationId: string): void {
    this.transaction(() => {
      const current = this.conversation(id)
      if (!current || current.revision !== revision) throw new OrchestrationError(409, "Conversation changed; refresh before switching")
      if (this.db.prepare("SELECT 1 FROM commands WHERE conversation_id=? AND state IN ('dispatching','delivered','unknown')").get(id)) throw new OrchestrationError(409, "Resolve active deliveries before switching")
      const reserved = this.db.prepare("SELECT operation_id,scope FROM transitions WHERE conversation_id=?").get(id) as Row | undefined
      if (reserved && (reserved.operation_id !== operationId || reserved.scope !== scope)) throw new OrchestrationError(409, "Another handoff is in progress")
      this.db.prepare("INSERT OR IGNORE INTO transitions(conversation_id,operation_id,scope) VALUES(?,?,?)").run(id, operationId, scope)
    })
  }
  private assertTransition(scope: string, id: string, operationId: string): void {
    if (!this.db.prepare("SELECT 1 FROM transitions WHERE conversation_id=? AND operation_id=? AND scope=?").get(id, operationId, scope)) throw new OrchestrationError(409, "This handoff does not own the conversation reservation")
  }
  private releaseTransition(scope: string, id: string, operationId: string): void { this.db.prepare("DELETE FROM transitions WHERE conversation_id=? AND operation_id=? AND scope=?").run(id, operationId, scope) }
  beginTransition(scope: string, id: string, hash: string, input: Record<string, unknown>, conversationId: string, revision: number) {
    return this.transaction(() => {
      this.reserveTransition(scope, conversationId, revision, id)
      return this.beginOperation(scope, id, hash, input)
    })
  }
  completeTransition(scope: string, id: string, conversationId: string, revision: number, binding: NativeBinding, result: Record<string, unknown>): Record<string, unknown> {
    return this.transaction(() => {
      this.assertTransition(scope, conversationId, id)
      const conversation = this.transition(conversationId, revision, binding)
      const completed = { ...result, conversation }
      this.finishOperation(scope, id, completed)
      this.releaseTransition(scope, conversationId, id)
      return completed
    })
  }
  abandonTransition(scope: string, id: string, conversationId: string): Record<string, unknown> {
    return this.transaction(() => {
      this.assertTransition(scope, conversationId, id)
      const result = { mode: "cancelled", conversation: this.conversation(conversationId) }
      this.finishOperation(scope, id, result)
      this.releaseTransition(scope, conversationId, id)
      return result
    })
  }

  admit(scope: string, id: string, conversationId: string, payload: Record<string, unknown>, intent: CommandIntent = "queue", replaces?: string): CommandReceipt {
    if (!/^[a-zA-Z0-9_-]{8,128}$/.test(id)) throw new OrchestrationError(400, "commandId must contain 8–128 letters, digits, underscores or hyphens")
    if (JSON.stringify(payload).length > 50 * 1024 * 1024) throw new OrchestrationError(413, "Command attachments exceed the durable storage limit")
    return this.transaction(() => {
      const conversation = this.conversation(conversationId)
      if (!conversation) throw new OrchestrationError(404, "Conversation not found")
      const hash = fingerprint({ conversationId, payload, intent, replaces })
      const existing = this.command(scope, id)
      if (existing) {
        if (existing.fingerprint !== hash) throw new OrchestrationError(409, "commandId was already accepted with different content")
        return existing.receipt
      }
      if (this.db.prepare("SELECT 1 FROM transitions WHERE conversation_id=?").get(conversationId)) throw new OrchestrationError(409, "Provider handoff is in progress; inspect its receipt before sending")
      const count = this.db.prepare("SELECT COUNT(*) AS n FROM commands WHERE conversation_id=? AND state IN ('queued','held')").get(conversationId) as Row
      if (Number(count.n) >= 100) throw new OrchestrationError(429, "Conversation queue is full")
      const bytes = Number((this.db.prepare("SELECT COALESCE(SUM(length(payload)),0) AS n FROM commands").get() as Row).n)
      if (bytes + JSON.stringify(payload).length > 512 * 1024 * 1024) throw new OrchestrationError(507, "Durable command storage is full; clear completed session history before adding attachments")
      const position = Number((this.db.prepare("SELECT COALESCE(MAX(position),0)+1 AS n FROM commands WHERE conversation_id=?").get(conversationId) as Row).n)
      const nativeHash = fingerprint([scope, id]).slice(0, 32)
      const nativeMessageId = `${nativeHash.slice(0, 8)}-${nativeHash.slice(8, 12)}-${nativeHash.slice(12, 16)}-${nativeHash.slice(16, 20)}-${nativeHash.slice(20)}`
      const accepted: CommandReceipt = { id, nativeMessageId, conversationId, sessionId: conversation.binding.sessionId, bindingRevision: conversation.revision, state: "queued", intent, message: typeof payload.message === "string" ? payload.message : undefined, questionId: typeof payload.questionId === "string" ? payload.questionId : undefined, createdAt: this.now(), updatedAt: this.now(), position, replaces }
      this.db.prepare("INSERT INTO commands(scope,id,conversation_id,fingerprint,payload,receipt,state,position,updated_at) VALUES(?,?,?,?,?,?,?,?,?)").run(scope, id, conversationId, hash, JSON.stringify(payload), JSON.stringify(accepted), accepted.state, position, accepted.updatedAt)
      this.event(conversationId, "command", accepted, scope)
      return accepted
    })
  }
  command(scope: string, id: string): StoredCommand | null {
    const row = this.db.prepare("SELECT * FROM commands WHERE scope=? AND id=?").get(scope, id) as Row | undefined
    return row ? { receipt: receipt(row), scope, payload: decode(row.payload), fingerprint: String(row.fingerprint), attempt: Number(row.attempt), epoch: Number(row.epoch) } : null
  }
  commands(conversationId: string, scope: string): CommandReceipt[] { return (this.db.prepare("SELECT * FROM commands WHERE conversation_id=? AND scope=? ORDER BY position").all(conversationId, scope) as Row[]).map(receipt) }
  pending(scope?: string): StoredCommand[] {
    const rows = (scope === undefined ? this.db.prepare("SELECT scope,id FROM commands WHERE state IN ('queued','held','dispatching','delivered','unknown')").all() : this.db.prepare("SELECT scope,id FROM commands WHERE scope=? AND state IN ('queued','held','dispatching','delivered','unknown')").all(scope)) as Row[]
    return rows.map((r) => this.command(String(r.scope), String(r.id))!)
  }

  acquire(owner: string, ttl = 15000): DispatcherLease | null {
    return this.transaction(() => {
      const old = this.db.prepare("SELECT * FROM dispatcher WHERE id=1").get() as Row | undefined
      if (old && old.owner !== owner && Number(old.expires_at) > this.now()) return null
      if (old?.owner === owner && Number(old.expires_at) > this.now()) {
        this.db.prepare("UPDATE dispatcher SET expires_at=? WHERE id=1").run(this.now() + ttl)
        return { owner, epoch: Number(old.epoch) }
      }
      const epoch = Number(old?.epoch ?? 0) + 1
      this.db.prepare("INSERT INTO dispatcher VALUES(1,?,?,?) ON CONFLICT(id) DO UPDATE SET owner=excluded.owner,epoch=excluded.epoch,expires_at=excluded.expires_at").run(owner, epoch, this.now() + ttl)
      for (const command of this.pending()) {
        if (command.receipt.state === "dispatching" || command.receipt.state === "delivered") this.update(command, "unknown", { error: "Host stopped during delivery. Inspect native history before resolving or resending." })
        else if (command.receipt.state === "queued") this.update(command, "held", { error: "Host restarted; resume this queue after reviewing it." })
      }
      return { owner, epoch }
    })
  }
  release(lease: DispatcherLease): void { this.db.prepare("UPDATE dispatcher SET expires_at=0 WHERE id=1 AND owner=? AND epoch=?").run(lease.owner, lease.epoch) }
  private owns(lease: DispatcherLease): boolean { return Boolean(this.db.prepare("SELECT 1 FROM dispatcher WHERE id=1 AND owner=? AND epoch=? AND expires_at>?").get(lease.owner, lease.epoch, this.now())) }
  currentAttempt(command: StoredCommand, lease: DispatcherLease): boolean {
    const current = this.command(command.scope, command.receipt.id)
    return this.owns(lease) && Boolean(current && current.attempt === command.attempt && current.epoch === lease.epoch && ["dispatching", "delivered"].includes(current.receipt.state))
  }
  claim(scope: string, id: string, lease: DispatcherLease): StoredCommand | null {
    return this.transaction(() => {
      if (!this.owns(lease)) return null
      const command = this.command(scope, id)
      if (!command || command.receipt.state !== "queued") return null
      const conversation = this.conversation(command.receipt.conversationId)!
      if (this.db.prepare("SELECT 1 FROM transitions WHERE conversation_id=?").get(conversation.id)) return null
      if (conversation.revision !== command.receipt.bindingRevision) { this.update(command, "held", { error: "Provider binding changed; cancel or replace this message." }); return null }
      const blocking = this.db.prepare("SELECT 1 FROM commands WHERE conversation_id=? AND (scope<>? OR id<>?) AND (state IN ('dispatching','unknown') OR (position<? AND state IN ('queued','held','delivered'))) LIMIT 1").get(conversation.id, scope, id, command.receipt.position)
      if (blocking && command.receipt.intent === "queue") return null
      if (this.db.prepare("SELECT 1 FROM commands WHERE conversation_id=? AND state IN ('dispatching','unknown') LIMIT 1").get(conversation.id)) return null
      this.db.prepare("UPDATE commands SET attempt=attempt+1,epoch=? WHERE scope=? AND id=?").run(lease.epoch, scope, id)
      this.update(command, "dispatching")
      return this.command(scope, id)
    })
  }
  finish(command: StoredCommand, lease: DispatcherLease, state: CommandState, details: Partial<CommandReceipt> = {}): boolean {
    return this.transaction(() => {
      const current = this.command(command.scope, command.receipt.id)
      if (!this.owns(lease) || !current || current.attempt !== command.attempt || current.epoch !== lease.epoch || !["dispatching", "delivered"].includes(current.receipt.state)) return false
      this.update(current, state, details)
      return true
    })
  }
  private update(command: StoredCommand, state: CommandState, details: Partial<CommandReceipt> = {}): void {
    const updated = { ...command.receipt, ...details, state, updatedAt: this.now() }
    this.db.prepare("UPDATE commands SET state=?,receipt=?,updated_at=? WHERE scope=? AND id=?").run(state, JSON.stringify(updated), updated.updatedAt, command.scope, command.receipt.id)
    this.event(updated.conversationId, "command", updated, command.scope)
    if ((state === "cancelled" || state === "failed") && !command.receipt.delivery) this.releaseAnswer(command)
  }
  private releaseAnswer(command: StoredCommand, reconcileLegacy = false): void {
    const question = command.payload.answerQuestion as { instanceId: string; sessionId: string; requestId: string } | undefined
    if (question) this.db.prepare("UPDATE questions SET answer_command_id=NULL,answer_scope=NULL WHERE instance_id=? AND session_id=? AND request_id=? AND answer_command_id=? AND (answer_scope=? OR (? AND answer_scope IS NULL AND (SELECT COUNT(*) FROM commands WHERE id=?)=1))").run(question.instanceId, question.sessionId, question.requestId, command.receipt.id, command.scope, reconcileLegacy ? 1 : 0, command.receipt.id)
  }
  cancel(scope: string, id: string): CommandReceipt {
    return this.transaction(() => {
      const command = this.command(scope, id)
      if (!command) throw new OrchestrationError(404, "Command not found")
      if (command.receipt.state === "cancelled") return command.receipt
      if (!["queued", "held"].includes(command.receipt.state)) throw new OrchestrationError(409, "Delivery has begun; interrupt the turn instead")
      this.update(command, "cancelled")
      return this.command(scope, id)!.receipt
    })
  }
  replace(scope: string, id: string, newId: string, payload: Record<string, unknown>): CommandReceipt {
    return this.transaction(() => {
      const command = this.command(scope, id)
      if (!command) throw new OrchestrationError(404, "Command not found")
      const existing = this.command(scope, newId)
      if (existing) return this.admit(scope, newId, command.receipt.conversationId, payload, command.receipt.intent, id)
      this.cancel(scope, id)
      const updated = this.admit(scope, newId, command.receipt.conversationId, payload, command.receipt.intent, id)
      this.linkAnswer(scope, payload, newId)
      this.db.prepare("UPDATE commands SET position=? WHERE scope=? AND id=?").run(command.receipt.position, scope, newId)
      return { ...updated, position: command.receipt.position }
    })
  }
  resume(scope: string, conversationId: string): void {
    this.transaction(() => {
      if (this.db.prepare("SELECT 1 FROM commands WHERE conversation_id=? AND state='unknown'").get(conversationId)) throw new OrchestrationError(409, "Resolve uncertain deliveries before resuming the queue")
      const conversation = this.conversation(conversationId)
      for (const command of this.pending(scope)) if (command.receipt.conversationId === conversationId && command.receipt.state === "held" && command.receipt.bindingRevision === conversation?.revision) this.update(command, "queued", { error: undefined })
    })
  }
  promote(scope: string, id: string, newId: string, intent: CommandIntent): CommandReceipt {
    return this.transaction(() => {
      const command = this.command(scope, id)
      if (!command) throw new OrchestrationError(404, "Command not found")
      if (!this.command(scope, newId)) this.cancel(scope, id)
      const receipt = this.admit(scope, newId, command.receipt.conversationId, command.payload, intent, id)
      this.linkAnswer(scope, command.payload, newId)
      return receipt
    })
  }
  resendUnknown(scope: string, id: string, newId: string): CommandReceipt {
    return this.transaction(() => {
      const command = this.command(scope, id)
      if (!command) throw new OrchestrationError(404, "Command not found")
      if (!this.command(scope, newId)) this.resolveUnknown(scope, id, "failed")
      const receipt = this.admit(scope, newId, command.receipt.conversationId, command.payload, command.receipt.intent, id)
      this.linkAnswer(scope, command.payload, newId)
      return receipt
    })
  }
  resolveUnknown(scope: string, id: string, disposition: "completed" | "failed"): void {
    this.transaction(() => {
      const command = this.command(scope, id)
      if (!command || command.receipt.state !== "unknown") throw new OrchestrationError(409, "Command is not awaiting delivery reconciliation")
      this.update(command, disposition, { error: disposition === "failed" ? "User confirmed this delivery did not succeed" : undefined })
      if (disposition === "failed") this.releaseAnswer(command, true)
    })
  }
  reorder(scope: string, conversationId: string, ids: string[]): void {
    this.transaction(() => {
      const editable = this.commands(conversationId, scope).filter((c) => c.state === "queued" || c.state === "held")
      if (new Set(ids).size !== ids.length || ids.length !== editable.length || editable.some((c) => !ids.includes(c.id))) throw new OrchestrationError(409, "Queue changed; refresh before reordering")
      const positions = editable.map((c) => c.position).sort((a, b) => a - b)
      ids.forEach((id, i) => { this.db.prepare("UPDATE commands SET position=? WHERE scope=? AND id=?").run(positions[i]!, scope, id); this.event(conversationId, "command", this.command(scope, id)!.receipt, scope) })
    })
  }

  putQuestion(question: StoredQuestion): void {
    this.transaction(() => {
      this.db.prepare("INSERT INTO questions(instance_id,session_id,request_id,data,answer_command_id) VALUES(?,?,?,?,?) ON CONFLICT(instance_id,session_id,request_id) DO NOTHING").run(question.instanceId, question.sessionId, question.requestId, JSON.stringify(question.data), question.answerCommandId ?? null)
    })
  }
  questions(instanceId: string, sessionId?: string): StoredQuestion[] {
    const rows = (sessionId === undefined ? this.db.prepare("SELECT * FROM questions WHERE instance_id=? AND answer_command_id IS NULL").all(instanceId) : this.db.prepare("SELECT * FROM questions WHERE instance_id=? AND session_id=? AND answer_command_id IS NULL").all(instanceId, sessionId)) as Row[]
    return rows.map((r) => ({ sessionId: String(r.session_id), requestId: String(r.request_id), instanceId, data: decode(r.data) }))
  }
  resolveQuestion(instanceId: string, sessionId: string, requestId: string, commandId: string, scope?: string): void { this.db.prepare("UPDATE questions SET answer_command_id=?,answer_scope=? WHERE instance_id=? AND session_id=? AND request_id=? AND answer_command_id IS NULL").run(commandId, scope ?? null, instanceId, sessionId, requestId) }
  private linkAnswer(scope: string, payload: Record<string, unknown>, commandId: string): void {
    const question = payload.answerQuestion as { instanceId: string; sessionId: string; requestId: string } | undefined
    if (question) this.resolveQuestion(question.instanceId, question.sessionId, question.requestId, commandId, scope)
  }
  deleteQuestions(instanceId: string, sessionId: string): void { this.db.prepare("DELETE FROM questions WHERE instance_id=? AND session_id=?").run(instanceId, sessionId) }
  admitAnswer(scope: string, id: string, conversationId: string, payload: Record<string, unknown>, instanceId: string, sessionId: string, requestId: string): CommandReceipt {
    return this.transaction(() => {
      const q = this.db.prepare("SELECT answer_command_id,answer_scope FROM questions WHERE instance_id=? AND session_id=? AND request_id=?").get(instanceId, sessionId, requestId) as Row | undefined
      if (!q) throw new OrchestrationError(404, "Question not found")
      if (q.answer_command_id && (q.answer_command_id !== id || q.answer_scope !== scope)) throw new OrchestrationError(409, "Question already has an accepted answer")
      const result = this.admit(scope, id, conversationId, payload, "steer")
      this.resolveQuestion(instanceId, sessionId, requestId, id, scope)
      this.event(conversationId, "question", { requestId, commandId: id, state: "answer_queued" }, scope)
      return result
    })
  }

  events(conversationId: string, after: number, limit = 200, scope?: string): EventPage {
    if (!Number.isSafeInteger(after) || after < 0) throw new OrchestrationError(400, "Invalid event cursor")
    const bounds = this.db.prepare("SELECT COALESCE(MIN(sequence),0) AS oldest,COALESCE(MAX(sequence),0) AS newest FROM events").get() as Row
    const reset = after > Number(bounds.newest) || (after > 0 && after < Number(bounds.oldest) - 1)
    const rows = this.db.prepare("SELECT * FROM events WHERE conversation_id=? AND sequence>? ORDER BY sequence LIMIT ?").all(conversationId, reset ? 0 : after, Math.min(500, Math.max(1, limit)) + 1) as Row[]
    limit = Math.min(500, Math.max(1, limit))
    const hasMore = rows.length > limit
    const events = rows.slice(0, limit).filter((row) => { return !scope || row.scope === scope || row.type === "binding" }).map((r) => ({ sequence: Number(r.sequence), conversationId, type: r.type as ConversationEvent["type"], createdAt: Number(r.created_at), data: decode(r.data) }))
    return { events, reset, hasMore, cursor: hasMore ? Number(rows[limit - 1]!.sequence) : Number(bounds.newest) }
  }

  putTask(scope: string, input: Omit<DelegatedTask, "id" | "createdAt" | "updatedAt" | "state">): DelegatedTask {
    return this.transaction(() => {
      const old = this.db.prepare("SELECT data FROM tasks WHERE scope=? AND source_id=?").get(scope, input.sourceId) as Row | undefined
      if (old) {
        const task = decode<DelegatedTask>(old.data)
        if (task.parentSessionId !== input.parentSessionId || task.childSessionId !== input.childSessionId) throw new OrchestrationError(409, "Task source ID was reused for a different delegation")
        return task
      }
      const task: DelegatedTask = { ...input, id: randomUUID(), state: "running", createdAt: this.now(), updatedAt: this.now() }
      this.db.prepare("INSERT INTO tasks VALUES(?,?,?,?)").run(task.id, scope, task.sourceId, JSON.stringify(task))
      return task
    })
  }
  tasks(scope: string, parentSessionId?: string): DelegatedTask[] {
    return (this.db.prepare("SELECT data FROM tasks WHERE scope=?").all(scope) as Row[]).map((r) => decode<DelegatedTask>(r.data)).filter((t) => parentSessionId === undefined || t.parentSessionId === parentSessionId)
  }
  updateTask(scope: string, id: string, patch: Partial<Pick<DelegatedTask, "state" | "result" | "wakeupCommandId" | "acknowledgedAt" | "deliveryDisposition" | "blockingDeadline">>, expectedState?: DelegatedTask["state"]): DelegatedTask {
    return this.transaction(() => {
      const old = this.tasks(scope).find((t) => t.id === id)
      if (!old) throw new OrchestrationError(404, "Delegated task not found")
      if (expectedState && old.state !== expectedState) return old
      if (patch.result && JSON.stringify(patch.result).length > 1024 * 1024) patch = { ...patch, result: { truncated: true, childSessionId: old.childSessionId, excerpt: JSON.stringify(patch.result).slice(0, 24000) } }
      const task = { ...old, ...patch, updatedAt: this.now() }
      this.db.prepare("UPDATE tasks SET data=? WHERE scope=? AND id=?").run(JSON.stringify(task), scope, id)
      return task
    })
  }
  forgetSession(sessionId: string): void {
    this.transaction(() => {
      this.db.prepare("DELETE FROM commands WHERE json_extract(receipt,'$.sessionId')=?").run(sessionId)
      for (const row of this.db.prepare("SELECT native_key,conversation_id,data FROM bindings").all() as Row[]) {
        if (decode<NativeBinding>(row.data).sessionId !== sessionId) continue
        const id = String(row.conversation_id)
        this.db.prepare("DELETE FROM bindings WHERE native_key=?").run(String(row.native_key))
        if (!this.db.prepare("SELECT 1 FROM bindings WHERE conversation_id=?").get(id)) {
          this.db.prepare("DELETE FROM commands WHERE conversation_id=?").run(id)
          this.db.prepare("DELETE FROM events WHERE conversation_id=?").run(id)
          this.db.prepare("DELETE FROM transitions WHERE conversation_id=?").run(id)
          this.db.prepare("DELETE FROM conversations WHERE id=?").run(id)
        } else if (this.conversation(id)?.binding.sessionId === sessionId) {
          const remaining = this.db.prepare("SELECT native_key,data FROM bindings WHERE conversation_id=? LIMIT 1").get(id) as Row
          const conversation = this.conversation(id)!
          const updated = { ...conversation, binding: decode<NativeBinding>(remaining.data), revision: conversation.revision + 1, updatedAt: this.now() }
          this.db.prepare("UPDATE conversations SET native_key=?,data=? WHERE id=?").run(String(remaining.native_key), JSON.stringify(updated), id)
          this.event(id, "binding", updated)
        }
      }
      this.db.prepare("DELETE FROM tasks WHERE json_extract(data,'$.parentSessionId')=? OR json_extract(data,'$.childSessionId')=?").run(sessionId, sessionId)
      this.db.prepare("DELETE FROM operations WHERE json_extract(result,'$.sessionId')=? OR json_extract(input,'$.input.sessionId')=?").run(sessionId, sessionId)
    })
  }
  prunePayloads(retentionMs = 30 * 86400000): void {
    this.transaction(() => {
      const cutoff = this.now() - retentionMs
      this.db.prepare("DELETE FROM events WHERE created_at<?").run(cutoff)
      for (const row of this.db.prepare("SELECT scope,id,result FROM operations WHERE result IS NOT NULL AND updated_at<?").all(cutoff) as Row[]) {
        const result = decode<Record<string, unknown>>(row.result)
        this.db.prepare("UPDATE operations SET input='{}',result=? WHERE scope=? AND id=?").run(JSON.stringify({ ...result, initialContent: undefined }), String(row.scope), String(row.id))
      }
      for (const row of this.db.prepare("SELECT * FROM commands WHERE updated_at<? AND state IN ('completed','failed','cancelled')").all(cutoff) as Row[]) {
        const value = receipt(row)
        const question = decode<Record<string, unknown>>(row.payload).answerQuestion as { instanceId: string; sessionId: string; requestId: string } | undefined
        if (question) this.db.prepare("DELETE FROM questions WHERE instance_id=? AND session_id=? AND request_id=? AND answer_command_id=? AND answer_scope=?").run(question.instanceId, question.sessionId, question.requestId, value.id, String(row.scope))
        this.db.prepare("UPDATE commands SET payload='{}',receipt=? WHERE scope=? AND id=?").run(JSON.stringify({ ...value, message: undefined, error: undefined }), String(row.scope), String(row.id))
      }
      for (const row of this.db.prepare("SELECT * FROM tasks").all() as Row[]) {
        const task = decode<DelegatedTask>(row.data)
        if (task.acknowledgedAt && task.acknowledgedAt < cutoff) this.db.prepare("UPDATE tasks SET data=? WHERE id=?").run(JSON.stringify({ ...task, result: undefined }), String(row.id))
      }
    })
  }
  instances(): ProviderInstance[] { return (this.db.prepare("SELECT data FROM instances").all() as Row[]).map((r) => decode<ProviderInstance>(r.data)) }
  putInstance(instance: ProviderInstance): void { this.db.prepare("INSERT INTO instances VALUES(?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data").run(instance.id, JSON.stringify(instance)); this.protectFiles() }
  deleteInstance(id: string): void { this.db.prepare("DELETE FROM instances WHERE id=?").run(id) }
  operation(scope: string, id: string): { fingerprint: string; input: Record<string, unknown>; result?: unknown } | null {
    const row = this.db.prepare("SELECT fingerprint,input,result FROM operations WHERE scope=? AND id=?").get(scope, id) as Row | undefined
    return row ? { fingerprint: String(row.fingerprint), input: decode(row.input), ...(row.result ? { result: decode(row.result) } : {}) } : null
  }
  pendingTransition(conversationId: string, scope: string): { id: string; sessionId?: string; agent?: unknown; instanceId?: unknown } | null {
    const reserved = this.db.prepare("SELECT operation_id,scope FROM transitions WHERE conversation_id=?").get(conversationId) as Row | undefined
    if (!reserved || reserved.scope !== scope) return null
    const operation = this.operation(scope, String(reserved.operation_id))
    if (!operation || operation.result) return null
    const input = operation.input.input as Record<string, unknown>
    return { id: String(reserved.operation_id).replace(/^transition-/, ""), sessionId: typeof operation.input.createdSessionId === "string" ? operation.input.createdSessionId : undefined, agent: input.agent, instanceId: input.instanceId }
  }
  recordOperationIdentity(scope: string, id: string, sessionId: string): void {
    const operation = this.operation(scope, id)
    if (operation && !operation.result) this.db.prepare("UPDATE operations SET input=? WHERE scope=? AND id=?").run(JSON.stringify({ ...operation.input, createdSessionId: sessionId }), scope, id)
  }
  beginOperation(scope: string, id: string, hash: string, input: unknown, importedResult?: unknown): { fresh: boolean; result?: unknown } {
    return this.transaction(() => {
      const old = this.db.prepare("SELECT fingerprint,result FROM operations WHERE scope=? AND id=?").get(scope, id) as Row | undefined
      if (old) {
        if (old.fingerprint !== hash) throw new OrchestrationError(409, "requestId was already used with a different session request")
        return { fresh: false, ...(old.result ? { result: decode(old.result) } : {}) }
      }
      this.db.prepare("INSERT INTO operations(scope,id,fingerprint,input,result,updated_at) VALUES(?,?,?,?,?,?)").run(scope, id, hash, JSON.stringify(input), importedResult === undefined ? null : JSON.stringify(importedResult), this.now())
      return { fresh: importedResult === undefined, ...(importedResult === undefined ? {} : { result: importedResult }) }
    })
  }
  finishOperation(scope: string, id: string, result: unknown): void {
    this.transaction(() => { this.db.prepare("UPDATE operations SET result=?,updated_at=? WHERE scope=? AND id=? AND result IS NULL").run(JSON.stringify(result), this.now(), scope, id) })
  }
}
