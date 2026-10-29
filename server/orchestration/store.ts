import { createHash, randomUUID } from "node:crypto"
import { chmodSync, existsSync, mkdirSync } from "node:fs"
import { dirname } from "node:path"
import { openDatabase, type SqliteDatabase } from "./database"
import type { CommandIntent, CommandReceipt, CommandState, Conversation, ConversationEvent, DelegatedTask, EventPage, NativeBinding, ProviderInstance } from "../../shared/contracts/orchestration"
import type { CrewChatAuthor, CrewChatDelivery, CrewChatMessage } from "../../shared/contracts/crewChat"
import { isTerminalOccurrence, occurrenceCommandId, occurrenceCreationId, type ExecutionGrant, type GrantRef, type OccurrenceHold, type OccurrenceInput, type OccurrenceState, type TriggerOccurrence, type TriggerRecord, type UnattendedAction } from "../../shared/contracts/triggers"

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
/** An occurrence a dispatcher claimed: its writes count only while this attempt and lease are current. */
export interface ClaimedOccurrence { occurrence: TriggerOccurrence; attempt: number; epoch: number }
export interface OccurrenceRecord {
  triggerId: string
  kind: string
  key: string
  dueAt: number
  action: UnattendedAction
  grant: GrantRef | null
  request: Record<string, unknown>
  input?: Omit<OccurrenceInput, "key" | "receivedAt">
  /** Cancel it once someone else messages this conversation after it was recorded. */
  fence?: { conversationId: string }
  /** Fold into the newest still-scheduled occurrence recorded within `windowMs`, up to `maxInputs`. */
  coalesce?: { windowMs: number; maxInputs: number }
  /** Refuse once this many of the trigger's occurrences are still waiting. */
  backlog?: number
  /** Its command must pass the kind's delivery guard (see deliveryGuards.ts). */
  guarded?: boolean
}
export type RecordedOccurrence = { occurrence: TriggerOccurrence; outcome: "created" | "duplicate" | "coalesced" }
type TriggerListener = (change: { type: "trigger" | "occurrence"; scope: string; triggerId: string; id: string }) => void
const OCCURRENCE_REQUEST_LIMIT = 256 * 1024
const OCCURRENCE_INPUTS_LIMIT = 1024 * 1024
const ACTIVE_OCCURRENCE = "('admitting','creating')"

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
/** A message that joined a turn already running, or only informs, is done once the agent accepts it: the turn's outcome is not its own. */
export function settlesOnDelivery(delivery: string | undefined, payload: Record<string, unknown>): boolean {
  return delivery !== undefined && (delivery !== "started" || payload.notification === true)
}

export class OrchestrationStore {
  private readonly db: SqliteDatabase
  private readonly listeners = new Set<(event: ConversationEvent) => void>()
  private readonly triggerListeners = new Set<TriggerListener>()
  private pendingEvents: ConversationEvent[] | null = null
  private pendingTriggerEvents: Parameters<TriggerListener>[0][] = []

  constructor(readonly path: string, private readonly now: () => number = Date.now) {
    if (path !== ":memory:") {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
      if (process.platform !== "win32") chmodSync(dirname(path), 0o700)
    }
    this.db = openDatabase(path)
    try {
      this.db.exec("PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;")
      const version = Number((this.db.prepare("PRAGMA user_version").get() as Row).user_version)
      if (version > 5) throw new Error("Orchestration database was created by a newer Cogpit; upgrade before opening it")
      this.transaction(() => {
        this.db.exec(`
          CREATE TABLE IF NOT EXISTS conversations(id TEXT PRIMARY KEY, native_key TEXT UNIQUE NOT NULL, data TEXT NOT NULL);
          CREATE TABLE IF NOT EXISTS bindings(native_key TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id), data TEXT NOT NULL);
          CREATE TABLE IF NOT EXISTS commands(scope TEXT NOT NULL, id TEXT NOT NULL, conversation_id TEXT NOT NULL REFERENCES conversations(id), fingerprint TEXT NOT NULL, payload TEXT NOT NULL, receipt TEXT NOT NULL, state TEXT NOT NULL, position INTEGER NOT NULL, attempt INTEGER NOT NULL DEFAULT 0, epoch INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL, PRIMARY KEY(scope,id));
          CREATE INDEX IF NOT EXISTS command_queue ON commands(conversation_id,position,state);
          CREATE INDEX IF NOT EXISTS command_pending ON commands(state,position,scope,id);
          CREATE TABLE IF NOT EXISTS questions(instance_id TEXT NOT NULL, session_id TEXT NOT NULL, request_id TEXT NOT NULL, data TEXT NOT NULL, answer_command_id TEXT, PRIMARY KEY(instance_id,session_id,request_id));
          CREATE TABLE IF NOT EXISTS events(sequence INTEGER PRIMARY KEY AUTOINCREMENT, conversation_id TEXT NOT NULL, type TEXT NOT NULL, created_at INTEGER NOT NULL, data TEXT NOT NULL);
          CREATE INDEX IF NOT EXISTS event_conversation ON events(conversation_id,sequence);
          CREATE TABLE IF NOT EXISTS dispatcher(id INTEGER PRIMARY KEY CHECK(id=1), owner TEXT NOT NULL, epoch INTEGER NOT NULL, expires_at INTEGER NOT NULL);
          CREATE TABLE IF NOT EXISTS tasks(id TEXT PRIMARY KEY, scope TEXT NOT NULL, source_id TEXT NOT NULL, data TEXT NOT NULL, UNIQUE(scope,source_id));
          CREATE INDEX IF NOT EXISTS task_parent ON tasks(scope,json_extract(data,'$.parentSessionId'));
          CREATE TABLE IF NOT EXISTS instances(id TEXT PRIMARY KEY, data TEXT NOT NULL);
          CREATE TABLE IF NOT EXISTS transitions(conversation_id TEXT PRIMARY KEY, operation_id TEXT NOT NULL);
          CREATE TABLE IF NOT EXISTS operations(scope TEXT NOT NULL,id TEXT NOT NULL,fingerprint TEXT NOT NULL,input TEXT NOT NULL,result TEXT,PRIMARY KEY(scope,id));
          CREATE TABLE IF NOT EXISTS crew_chat_messages(sequence INTEGER PRIMARY KEY AUTOINCREMENT,root_id TEXT NOT NULL,scope TEXT NOT NULL,id TEXT NOT NULL,fingerprint TEXT NOT NULL,data TEXT NOT NULL,UNIQUE(scope,id));
          CREATE INDEX IF NOT EXISTS crew_chat_history ON crew_chat_messages(root_id,sequence);
          CREATE TABLE IF NOT EXISTS crew_chat_listeners(root_id TEXT NOT NULL,session_id TEXT NOT NULL,listening INTEGER NOT NULL DEFAULT 1,cursor INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(root_id,session_id));
          CREATE TABLE IF NOT EXISTS crew_chat_deliveries(sequence INTEGER NOT NULL REFERENCES crew_chat_messages(sequence) ON DELETE CASCADE,session_id TEXT NOT NULL,scope TEXT NOT NULL,kind TEXT NOT NULL,state TEXT NOT NULL DEFAULT 'pending',error TEXT,PRIMARY KEY(sequence,session_id));
          CREATE INDEX IF NOT EXISTS crew_chat_pending ON crew_chat_deliveries(scope,state,sequence);
          CREATE TABLE IF NOT EXISTS execution_grants(id TEXT PRIMARY KEY,scope TEXT NOT NULL,revision INTEGER NOT NULL,data TEXT NOT NULL,revoked_at INTEGER);
          CREATE TABLE IF NOT EXISTS triggers(scope TEXT NOT NULL,id TEXT NOT NULL,kind TEXT NOT NULL,revision INTEGER NOT NULL,state TEXT NOT NULL,next_due_at INTEGER,data TEXT NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,PRIMARY KEY(scope,id));
          CREATE INDEX IF NOT EXISTS trigger_due ON triggers(kind,state,next_due_at);
          CREATE TABLE IF NOT EXISTS trigger_secrets(scope TEXT NOT NULL,trigger_id TEXT NOT NULL,id TEXT NOT NULL,data TEXT NOT NULL,created_at INTEGER NOT NULL,retired_at INTEGER,PRIMARY KEY(scope,trigger_id,id));
          CREATE TABLE IF NOT EXISTS trigger_occurrences(scope TEXT NOT NULL,id TEXT NOT NULL,trigger_id TEXT NOT NULL,kind TEXT NOT NULL,state TEXT NOT NULL,due_at INTEGER NOT NULL,attempt INTEGER NOT NULL DEFAULT 0,epoch INTEGER NOT NULL DEFAULT 0,fence_conversation TEXT,fence_position INTEGER,data TEXT NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,PRIMARY KEY(scope,id));
          CREATE INDEX IF NOT EXISTS occurrence_due ON trigger_occurrences(state,due_at);
          CREATE INDEX IF NOT EXISTS occurrence_trigger ON trigger_occurrences(scope,trigger_id,created_at);
          CREATE INDEX IF NOT EXISTS occurrence_fence ON trigger_occurrences(fence_conversation,state);
          CREATE TABLE IF NOT EXISTS trigger_keys(scope TEXT NOT NULL,trigger_id TEXT NOT NULL,key TEXT NOT NULL,occurrence_id TEXT NOT NULL,fingerprint TEXT NOT NULL,created_at INTEGER NOT NULL,PRIMARY KEY(scope,trigger_id,key));
        `)
        if (!(this.db.prepare("PRAGMA table_info(events)").all() as Row[]).some((row) => row.name === "scope")) this.db.exec("ALTER TABLE events ADD COLUMN scope TEXT")
        if (!(this.db.prepare("PRAGMA table_info(operations)").all() as Row[]).some((row) => row.name === "updated_at")) this.db.exec("ALTER TABLE operations ADD COLUMN updated_at INTEGER NOT NULL DEFAULT 0")
        if (!(this.db.prepare("PRAGMA table_info(questions)").all() as Row[]).some((row) => row.name === "answer_scope")) this.db.exec("ALTER TABLE questions ADD COLUMN answer_scope TEXT")
        if (!(this.db.prepare("PRAGMA table_info(transitions)").all() as Row[]).some((row) => row.name === "scope")) {
          this.db.exec("ALTER TABLE transitions ADD COLUMN scope TEXT")
          this.db.exec("UPDATE transitions SET scope=(SELECT scope FROM operations WHERE id=transitions.operation_id) WHERE (SELECT COUNT(*) FROM operations WHERE id=transitions.operation_id)=1")
        }
        this.db.exec("PRAGMA user_version=5")
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
    } catch (error) { this.db.exec("ROLLBACK"); this.pendingTriggerEvents = []; throw error }
    finally { this.pendingEvents = null }
    this.protectFiles()
    for (const event of events) for (const listener of this.listeners) {
      try { listener(event) } catch { /* Committed state remains available through replay. */ }
    }
    for (const change of this.pendingTriggerEvents.splice(0)) for (const listener of this.triggerListeners) {
      try { listener(change) } catch { /* Readers re-read committed state. */ }
    }
    return result
  }

  close(): void { this.listeners.clear(); this.triggerListeners.clear(); this.db.close() }
  chatListener(rootId: string, sessionId: string): { listening: boolean; cursor: number } {
    const row = this.db.prepare("SELECT listening,cursor FROM crew_chat_listeners WHERE root_id=? AND session_id=?").get(rootId, sessionId) as Row | undefined
    return { listening: row ? Boolean(row.listening) : true, cursor: Number(row?.cursor ?? 0) }
  }
  setChatListening(rootId: string, sessionId: string, listening: boolean): void {
    this.transaction(() => this.db.prepare("INSERT INTO crew_chat_listeners(root_id,session_id,listening) VALUES(?,?,?) ON CONFLICT(root_id,session_id) DO UPDATE SET listening=excluded.listening").run(rootId, sessionId, Number(listening)))
  }
  setChatCursor(rootId: string, sessionId: string, cursor: number): void {
    this.transaction(() => this.db.prepare("INSERT INTO crew_chat_listeners(root_id,session_id,cursor) VALUES(?,?,?) ON CONFLICT(root_id,session_id) DO UPDATE SET cursor=MAX(cursor,excluded.cursor)").run(rootId, sessionId, cursor))
  }
  finishChatFetch(scope: string, id: string | undefined, hash: string, rootId: string, reader: string, page: { messages: CrewChatMessage[]; nextCursor: number; hasMore: boolean }): void {
    this.transaction(() => {
      if (id) this.beginOperation(scope, id, hash, { sessionId: rootId, reader })
      this.setChatCursor(rootId, reader, page.nextCursor)
      if (id) this.finishOperation(scope, id, page)
    })
  }
  postChat(scope: string, id: string, input: { rootId: string; author: CrewChatAuthor; text: string; mentions: string[] }, recipients: Pick<CrewChatDelivery, "sessionId" | "kind">[]): CrewChatMessage {
    if (!/^[a-zA-Z0-9_-]{8,128}$/.test(id)) throw new OrchestrationError(400, "commandId must contain 8–128 letters, digits, underscores or hyphens")
    return this.transaction(() => {
      const hash = fingerprint(input)
      const existing = this.db.prepare("SELECT sequence,fingerprint,data FROM crew_chat_messages WHERE scope=? AND id=?").get(scope, id) as Row | undefined
      if (existing) {
        if (existing.fingerprint !== hash) throw new OrchestrationError(409, "commandId was already accepted with different chat content")
        return { ...decode<CrewChatMessage>(existing.data), sequence: Number(existing.sequence) }
      }
      const message = { id, ...input, createdAt: this.now() }
      const result = this.db.prepare("INSERT INTO crew_chat_messages(root_id,scope,id,fingerprint,data) VALUES(?,?,?,?,?)").run(input.rootId, scope, id, hash, JSON.stringify(message))
      const sequence = Number(result.lastInsertRowid)
      for (const recipient of recipients) this.db.prepare("INSERT INTO crew_chat_deliveries(sequence,session_id,scope,kind) VALUES(?,?,?,?)").run(sequence, recipient.sessionId, scope, recipient.kind)
      return { ...message, sequence }
    })
  }
  chatMessage(sequence: number): CrewChatMessage | null {
    const row = this.db.prepare("SELECT data FROM crew_chat_messages WHERE sequence=?").get(sequence) as Row | undefined
    return row ? { ...decode<CrewChatMessage>(row.data), sequence } : null
  }
  chatMessages(rootId: string, options: { after?: number; before?: number; limit: number }): CrewChatMessage[] {
    const rows = options.after !== undefined
      ? this.db.prepare("SELECT sequence,data FROM crew_chat_messages WHERE root_id=? AND sequence>? ORDER BY sequence LIMIT ?").all(rootId, options.after, options.limit)
      : this.db.prepare("SELECT sequence,data FROM crew_chat_messages WHERE root_id=? AND sequence<? ORDER BY sequence DESC LIMIT ?").all(rootId, options.before ?? Number.MAX_SAFE_INTEGER, options.limit)
    const messages = (rows as Row[]).map((row) => ({ ...decode<CrewChatMessage>(row.data), sequence: Number(row.sequence) }))
    return options.after !== undefined ? messages : messages.reverse()
  }
  chatDeliveries(rootId: string, scope: string): CrewChatDelivery[] {
    return (this.db.prepare("SELECT d.* FROM crew_chat_deliveries d JOIN crew_chat_messages m ON m.sequence=d.sequence WHERE m.root_id=? AND d.scope=? AND d.state='pending' ORDER BY d.sequence").all(rootId, scope) as Row[]).map((row) => ({ sequence: Number(row.sequence), sessionId: String(row.session_id), scope: String(row.scope), kind: row.kind as CrewChatDelivery["kind"], state: "pending", ...(row.error ? { error: String(row.error) } : {}) }))
  }
  updateChatDelivery(delivery: CrewChatDelivery, state: CrewChatDelivery["state"], error?: string): void {
    this.transaction(() => this.db.prepare("UPDATE crew_chat_deliveries SET state=?,error=? WHERE sequence=? AND session_id=?").run(state, error ?? null, delivery.sequence, delivery.sessionId))
  }
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
      if (!payload.trigger && payload.notification !== true) this.cancelFenced(conversationId, "Someone messaged the session after this was scheduled")
      return accepted
    })
  }
  command(scope: string, id: string): StoredCommand | null {
    const row = this.db.prepare("SELECT * FROM commands WHERE scope=? AND id=?").get(scope, id) as Row | undefined
    return row ? { receipt: receipt(row), scope, payload: decode(row.payload), fingerprint: String(row.fingerprint), attempt: Number(row.attempt), epoch: Number(row.epoch) } : null
  }
  commands(conversationId: string, scope: string): CommandReceipt[] { return (this.db.prepare("SELECT * FROM commands WHERE conversation_id=? AND scope=? ORDER BY position").all(conversationId, scope) as Row[]).map(receipt) }
  pending(scope?: string): StoredCommand[] {
    const rows = (scope === undefined ? this.db.prepare("SELECT scope,id FROM commands WHERE state IN ('queued','held','dispatching','delivered','unknown') ORDER BY position").all() : this.db.prepare("SELECT scope,id FROM commands WHERE scope=? AND state IN ('queued','held','dispatching','delivered','unknown') ORDER BY position").all(scope)) as Row[]
    return rows.map((r) => this.command(String(r.scope), String(r.id))!)
  }
  queued(): StoredCommand[] {
    const rows = this.db.prepare("SELECT scope,id FROM commands WHERE state='queued' ORDER BY position").all() as Row[]
    return rows.map((r) => this.command(String(r.scope), String(r.id))!)
  }

  acquire(owner: string, ttl = 15000): DispatcherLease | null {
    return this.transaction(() => {
      const old = this.db.prepare("SELECT * FROM dispatcher WHERE id=1").get() as Row | undefined
      if (old && old.owner !== owner && Number(old.expires_at) > this.now()) return null
      // Only another host replaces the owner, so a lease that lapsed while this one slept is still its own.
      if (old?.owner === owner) {
        this.db.prepare("UPDATE dispatcher SET expires_at=? WHERE id=1").run(this.now() + ttl)
        return { owner, epoch: Number(old.epoch) }
      }
      const epoch = Number(old?.epoch ?? 0) + 1
      this.db.prepare("INSERT INTO dispatcher VALUES(1,?,?,?) ON CONFLICT(id) DO UPDATE SET owner=excluded.owner,epoch=excluded.epoch,expires_at=excluded.expires_at").run(owner, epoch, this.now() + ttl)
      for (const command of this.pending()) {
        if (["delivered", "unknown"].includes(command.receipt.state) && settlesOnDelivery(command.receipt.delivery, command.payload)) this.update(command, "completed", { error: undefined })
        else if (command.receipt.state === "dispatching" || command.receipt.state === "delivered") this.update(command, "unknown", { error: "Host stopped during delivery. Inspect native history before resolving or resending." })
        // A grant outlives the host, so work admitted under one stays queued and is re-authorized when it is claimed.
        else if (command.receipt.state === "queued" && !command.payload.executionGrant) this.update(command, "held", { error: "Host restarted; resume this queue after reviewing it." })
      }
      this.reconcileOccurrences(epoch)
      return { owner, epoch }
    })
  }
  release(lease: DispatcherLease): void { this.db.prepare("UPDATE dispatcher SET expires_at=0 WHERE id=1 AND owner=? AND epoch=?").run(lease.owner, lease.epoch) }
  private owns(lease: DispatcherLease): boolean { return Boolean(this.db.prepare("SELECT 1 FROM dispatcher WHERE id=1 AND owner=? AND epoch=?").get(lease.owner, lease.epoch)) }
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
  /** Whether a message that starts a turn is about to be handed over, with nothing held or uncertain blocking it. */
  startsNext(conversationId: string): boolean {
    if (this.db.prepare("SELECT 1 FROM commands WHERE conversation_id=? AND state IN ('held','unknown') LIMIT 1").get(conversationId)) return false
    return Boolean(this.db.prepare("SELECT 1 FROM commands WHERE conversation_id=? AND state IN ('queued','dispatching') AND json_extract(payload,'$.onlyWhileRunning') IS NOT 1 LIMIT 1").get(conversationId))
  }
  /** Cancels every message still waiting for a conversation, from any account, so a stop is final. */
  cancelWaiting(conversationId: string): number {
    return this.transaction(() => {
      const waiting = (this.db.prepare("SELECT scope,id FROM commands WHERE conversation_id=? AND state IN ('queued','held')").all(conversationId) as Row[])
        .map((row) => this.command(String(row.scope), String(row.id))!)
      for (const command of waiting) this.update(command, "cancelled", { error: "The session was stopped" })
      this.cancelFenced(conversationId, "The session was stopped")
      return waiting.length
    })
  }
  /** Stops results from a stopped session's children from waking it, from any account. */
  muteTasksOf(parentSessionId: string): number {
    return this.transaction(() => {
      const rows = this.db.prepare("SELECT scope,id,data FROM tasks WHERE json_extract(data,'$.parentSessionId')=?").all(parentSessionId) as Row[]
      let muted = 0
      for (const row of rows) {
        const task = decode<DelegatedTask>(row.data)
        if (task.acknowledgedAt || task.state === "cancelled") continue
        this.db.prepare("UPDATE tasks SET data=? WHERE scope=? AND id=?").run(JSON.stringify({ ...task, acknowledgedAt: this.now(), updatedAt: this.now() }), String(row.scope), String(row.id))
        muted++
      }
      return muted
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
    const rows = (parentSessionId === undefined
      ? this.db.prepare("SELECT data FROM tasks WHERE scope=?").all(scope)
      : this.db.prepare("SELECT data FROM tasks WHERE scope=? AND json_extract(data,'$.parentSessionId')=?").all(scope, parentSessionId)) as Row[]
    return rows.map((row) => decode<DelegatedTask>(row.data))
  }
  updateTask(scope: string, id: string, patch: Partial<Pick<DelegatedTask, "state" | "result" | "wakeupCommandId" | "acknowledgedAt" | "deliveryDisposition" | "blockingDeadline" | "notified">>, expectedState?: DelegatedTask["state"]): DelegatedTask {
    return this.transaction(() => {
      const row = this.db.prepare("SELECT data FROM tasks WHERE scope=? AND id=?").get(scope, id) as Row | undefined
      const old = row ? decode<DelegatedTask>(row.data) : undefined
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
      this.db.prepare("DELETE FROM crew_chat_messages WHERE root_id=?").run(sessionId)
      this.db.prepare("DELETE FROM crew_chat_listeners WHERE root_id=? OR session_id=?").run(sessionId, sessionId)
      this.db.prepare("DELETE FROM crew_chat_deliveries WHERE session_id=?").run(sessionId)
      for (const row of this.db.prepare("SELECT scope,id FROM trigger_occurrences WHERE json_extract(data,'$.sessionId')=? AND state NOT IN ('completed','failed','cancelled','skipped')").all(sessionId) as Row[]) this.settleOccurrence(String(row.scope), String(row.id), "cancelled", { reason: "The session was deleted" })
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
      this.db.prepare("DELETE FROM trigger_occurrences WHERE updated_at<? AND state IN ('completed','failed','cancelled','skipped')").run(cutoff)
      this.db.prepare("DELETE FROM trigger_keys WHERE created_at<? AND occurrence_id NOT IN (SELECT id FROM trigger_occurrences)").run(cutoff)
      this.db.prepare("DELETE FROM trigger_secrets WHERE retired_at IS NOT NULL AND retired_at<?").run(cutoff)
      this.db.prepare("DELETE FROM execution_grants WHERE revoked_at IS NOT NULL AND revoked_at<?").run(cutoff)
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

  // ── Unattended execution grants ──────────────────────────────────
  putGrant(grant: ExecutionGrant): ExecutionGrant {
    return this.transaction(() => {
      this.db.prepare("INSERT INTO execution_grants(id,scope,revision,data,revoked_at) VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,data=excluded.data,revoked_at=excluded.revoked_at").run(grant.id, grant.scope, grant.revision, JSON.stringify(grant), grant.revokedAt ?? null)
      return grant
    })
  }
  grant(id: string): ExecutionGrant | null {
    const row = this.db.prepare("SELECT data FROM execution_grants WHERE id=?").get(id) as Row | undefined
    return row ? decode<ExecutionGrant>(row.data) : null
  }
  grants(scope: string): ExecutionGrant[] { return (this.db.prepare("SELECT data FROM execution_grants WHERE scope=? ORDER BY id").all(scope) as Row[]).map((row) => decode<ExecutionGrant>(row.data)) }
  /** Revokes a grant for good; work it admitted is held for reauthorization as soon as it is next claimed. */
  revokeGrant(id: string, reason: string): ExecutionGrant | null {
    return this.transaction(() => {
      const grant = this.grant(id)
      if (!grant || grant.revokedAt) return grant
      return this.putGrant({ ...grant, revision: grant.revision + 1, revokedAt: this.now(), revokedReason: reason, updatedAt: this.now() })
    })
  }

  // ── Trigger definitions ──────────────────────────────────────────
  /** Whether any definition is active or any occurrence is still open, so the scheduler must run. */
  hasTriggerWork(): boolean {
    return Boolean(this.db.prepare("SELECT 1 FROM triggers WHERE state='active' UNION ALL SELECT 1 FROM trigger_occurrences WHERE state NOT IN ('completed','failed','cancelled','skipped') LIMIT 1").get())
  }
  subscribeTriggers(listener: TriggerListener): () => void { this.triggerListeners.add(listener); return () => this.triggerListeners.delete(listener) }
  private triggerEvent(type: "trigger" | "occurrence", scope: string, triggerId: string, id: string): void { this.pendingTriggerEvents.push({ type, scope, triggerId, id }) }
  private triggerRecord(row: Row): TriggerRecord {
    const data = decode<{ grant: GrantRef | null; data: Record<string, unknown> }>(row.data)
    return { id: String(row.id), scope: String(row.scope), kind: String(row.kind), revision: Number(row.revision), state: row.state as TriggerRecord["state"], grant: data.grant, nextDueAt: row.next_due_at === null ? null : Number(row.next_due_at), data: data.data, createdAt: Number(row.created_at), updatedAt: Number(row.updated_at) }
  }
  trigger(scope: string, id: string): TriggerRecord | null {
    const row = this.db.prepare("SELECT * FROM triggers WHERE scope=? AND id=?").get(scope, id) as Row | undefined
    return row ? this.triggerRecord(row) : null
  }
  triggers(scope: string | null, kind: string): TriggerRecord[] {
    const rows = scope === null ? this.db.prepare("SELECT * FROM triggers WHERE kind=? ORDER BY created_at,id").all(kind) : this.db.prepare("SELECT * FROM triggers WHERE scope=? AND kind=? ORDER BY created_at,id").all(scope, kind)
    return (rows as Row[]).map((row) => this.triggerRecord(row))
  }
  /** Active definitions of `kind` whose consumer asked to be woken by now. */
  dueTriggers(kind: string): TriggerRecord[] {
    return (this.db.prepare("SELECT * FROM triggers WHERE kind=? AND state='active' AND next_due_at IS NOT NULL AND next_due_at<=? ORDER BY next_due_at").all(kind, this.now()) as Row[]).map((row) => this.triggerRecord(row))
  }
  /** Creates a definition, or replaces it when `expectedRevision` is the stored one. */
  putTrigger(scope: string, input: Pick<TriggerRecord, "id" | "kind" | "state" | "grant" | "nextDueAt" | "data">, expectedRevision?: number): TriggerRecord {
    if (!/^[a-zA-Z0-9_-]{8,128}$/.test(input.id)) throw new OrchestrationError(400, "Trigger ids must contain 8–128 letters, digits, underscores or hyphens")
    if (JSON.stringify(input.data).length > OCCURRENCE_REQUEST_LIMIT) throw new OrchestrationError(413, "Trigger definition is too large")
    return this.transaction(() => {
      const old = this.trigger(scope, input.id)
      if (old && old.kind !== input.kind) throw new OrchestrationError(409, "Trigger id already belongs to another kind")
      if (old && expectedRevision === undefined) throw new OrchestrationError(409, "Trigger already exists")
      if (expectedRevision !== undefined && old?.revision !== expectedRevision) throw new OrchestrationError(409, "Trigger changed; refresh before saving")
      const revision = (old?.revision ?? 0) + 1
      const data = JSON.stringify({ grant: input.grant, data: input.data })
      this.db.prepare("INSERT INTO triggers(scope,id,kind,revision,state,next_due_at,data,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(scope,id) DO UPDATE SET revision=excluded.revision,state=excluded.state,next_due_at=excluded.next_due_at,data=excluded.data,updated_at=excluded.updated_at").run(scope, input.id, input.kind, revision, input.state, input.nextDueAt, data, old?.createdAt ?? this.now(), this.now())
      this.triggerEvent("trigger", scope, input.id, input.id)
      return this.trigger(scope, input.id)!
    })
  }
  /** Moves a definition's next wake-up without counting as an edit, unless it changed since `revision`. */
  setTriggerDue(scope: string, id: string, revision: number, nextDueAt: number | null): boolean {
    return this.transaction(() => {
      const changed = Number(this.db.prepare("UPDATE triggers SET next_due_at=? WHERE scope=? AND id=? AND revision=?").run(nextDueAt, scope, id, revision).changes) > 0
      if (changed) this.triggerEvent("trigger", scope, id, id)
      return changed
    })
  }
  /** Deletes a definition with its secrets, cancels what it still has waiting, and revokes a grant nothing else uses. */
  deleteTrigger(scope: string, id: string): void {
    this.transaction(() => {
      const trigger = this.trigger(scope, id)
      if (!trigger) return
      for (const row of this.db.prepare(`SELECT id FROM trigger_occurrences WHERE scope=? AND trigger_id=? AND state IN ('scheduled','held')`).all(scope, id) as Row[]) this.cancelOccurrence(scope, String(row.id), "The task was deleted")
      this.db.prepare("DELETE FROM trigger_secrets WHERE scope=? AND trigger_id=?").run(scope, id)
      this.db.prepare("DELETE FROM triggers WHERE scope=? AND id=?").run(scope, id)
      const grantId = trigger.grant?.grantId
      if (grantId && !this.db.prepare("SELECT 1 FROM triggers WHERE json_extract(data,'$.grant.grantId')=? LIMIT 1").get(grantId)) this.revokeGrant(grantId, "Its task was deleted")
      this.triggerEvent("trigger", scope, id, id)
    })
  }
  /** Key material a consumer verifies deliveries with. Never part of a definition, a list or a log. */
  putTriggerSecret(scope: string, triggerId: string, id: string, data: Record<string, unknown>): void {
    this.transaction(() => { this.db.prepare("INSERT INTO trigger_secrets(scope,trigger_id,id,data,created_at) VALUES(?,?,?,?,?)").run(scope, triggerId, id, JSON.stringify(data), this.now()) })
  }
  /** Retires every secret but `keep`, which stay valid for `graceMs` so a rotation does not drop deliveries already in flight. */
  retireTriggerSecrets(scope: string, triggerId: string, keep: string, graceMs: number): void {
    this.transaction(() => { this.db.prepare("UPDATE trigger_secrets SET retired_at=? WHERE scope=? AND trigger_id=? AND id<>? AND retired_at IS NULL").run(this.now() + graceMs, scope, triggerId, keep) })
  }
  triggerSecrets(scope: string, triggerId: string): Array<{ id: string; data: Record<string, unknown>; createdAt: number }> {
    return (this.db.prepare("SELECT id,data,created_at FROM trigger_secrets WHERE scope=? AND trigger_id=? AND (retired_at IS NULL OR retired_at>?) ORDER BY created_at DESC").all(scope, triggerId, this.now()) as Row[])
      .map((row) => ({ id: String(row.id), data: decode<Record<string, unknown>>(row.data), createdAt: Number(row.created_at) }))
  }

  // ── Trigger occurrences ──────────────────────────────────────────
  private occurrenceRow(row: Row): TriggerOccurrence {
    const data = decode<Omit<TriggerOccurrence, "id" | "scope" | "triggerId" | "kind" | "state" | "dueAt" | "attempt" | "createdAt" | "updatedAt" | "command">>(row.data)
    const command = this.command(String(row.scope), data.commandId)?.receipt
    return { ...data, id: String(row.id), scope: String(row.scope), triggerId: String(row.trigger_id), kind: String(row.kind), state: row.state as OccurrenceState, dueAt: Number(row.due_at), attempt: Number(row.attempt), createdAt: Number(row.created_at), updatedAt: Number(row.updated_at), ...(command ? { command } : {}) }
  }
  occurrence(scope: string, id: string): TriggerOccurrence | null {
    const row = this.db.prepare("SELECT * FROM trigger_occurrences WHERE scope=? AND id=?").get(scope, id) as Row | undefined
    return row ? this.occurrenceRow(row) : null
  }
  /** A trigger's occurrences, newest first. */
  occurrences(scope: string, triggerId: string, options: { before?: number; limit?: number } = {}): TriggerOccurrence[] {
    const limit = Math.min(200, Math.max(1, options.limit ?? 50))
    return (this.db.prepare("SELECT * FROM trigger_occurrences WHERE scope=? AND trigger_id=? AND created_at<? ORDER BY created_at DESC,id DESC LIMIT ?").all(scope, triggerId, options.before ?? Number.MAX_SAFE_INTEGER, limit) as Row[]).map((row) => this.occurrenceRow(row))
  }
  /** Occurrences of a trigger not yet settled: waiting, running, held or awaiting reconciliation. */
  openOccurrences(scope: string, triggerId: string): TriggerOccurrence[] {
    return (this.db.prepare("SELECT * FROM trigger_occurrences WHERE scope=? AND trigger_id=? AND state NOT IN ('completed','failed','cancelled','skipped') ORDER BY created_at").all(scope, triggerId) as Row[]).map((row) => this.occurrenceRow(row))
  }
  private writeOccurrence(occurrence: TriggerOccurrence, patch: Partial<TriggerOccurrence>, state: OccurrenceState = occurrence.state, dueAt = occurrence.dueAt): void {
    const old = decode<Record<string, unknown>>((this.db.prepare("SELECT data FROM trigger_occurrences WHERE scope=? AND id=?").get(occurrence.scope, occurrence.id) as Row).data)
    const terminal = isTerminalOccurrence(state)
    const data = { ...old, ...patch, ...(terminal && !old.finishedAt ? { finishedAt: this.now() } : {}) }
    this.db.prepare("UPDATE trigger_occurrences SET state=?,due_at=?,data=?,updated_at=? WHERE scope=? AND id=?").run(state, dueAt, JSON.stringify(data), this.now(), occurrence.scope, occurrence.id)
    this.triggerEvent("occurrence", occurrence.scope, occurrence.triggerId, occurrence.id)
  }
  /**
   * Records one due event. A key already recorded returns the occurrence it
   * made (a replayed delivery or a slot computed twice); different content
   * under the same key is refused. A burst can fold into the newest
   * occurrence still waiting instead of starting another run.
   */
  recordOccurrence(scope: string, input: OccurrenceRecord): RecordedOccurrence {
    if (!input.key || input.key.length > 256) throw new OrchestrationError(400, "Occurrence keys must contain 1–256 characters")
    if (JSON.stringify(input.request).length > OCCURRENCE_REQUEST_LIMIT) throw new OrchestrationError(413, "Occurrence request is too large")
    const hash = fingerprint({ request: input.request, data: input.input?.data ?? null, action: input.action })
    return this.transaction(() => {
      const seen = this.db.prepare("SELECT occurrence_id,fingerprint FROM trigger_keys WHERE scope=? AND trigger_id=? AND key=?").get(scope, input.triggerId, input.key) as Row | undefined
      if (seen) {
        if (seen.fingerprint !== hash) throw new OrchestrationError(409, "This delivery id was already recorded with different content")
        const existing = this.occurrence(scope, String(seen.occurrence_id))
        if (existing) return { occurrence: existing, outcome: "duplicate" }
        throw new OrchestrationError(409, "This delivery id was already recorded")
      }
      const received: OccurrenceInput | undefined = input.input ? { key: input.key, receivedAt: this.now(), data: input.input.data } : undefined
      if (input.coalesce && received) {
        const row = this.db.prepare("SELECT * FROM trigger_occurrences WHERE scope=? AND trigger_id=? AND state='scheduled' AND created_at>=? ORDER BY created_at DESC LIMIT 1").get(scope, input.triggerId, this.now() - input.coalesce.windowMs) as Row | undefined
        const target = row && this.occurrenceRow(row)
        if (target && target.inputs.length < input.coalesce.maxInputs && JSON.stringify([...target.inputs, received]).length <= OCCURRENCE_INPUTS_LIMIT) {
          this.writeOccurrence(target, { inputs: [...target.inputs, received] })
          this.db.prepare("INSERT INTO trigger_keys VALUES(?,?,?,?,?,?)").run(scope, input.triggerId, input.key, target.id, hash, this.now())
          return { occurrence: this.occurrence(scope, target.id)!, outcome: "coalesced" }
        }
      }
      if (received && JSON.stringify(received).length > OCCURRENCE_INPUTS_LIMIT) throw new OrchestrationError(413, "Occurrence input is too large")
      const waiting = Number((this.db.prepare("SELECT COUNT(*) AS n FROM trigger_occurrences WHERE scope=? AND trigger_id=? AND state IN ('scheduled','held')").get(scope, input.triggerId) as Row).n)
      if (waiting >= (input.backlog ?? 100)) throw new OrchestrationError(429, "Too many runs of this task are already waiting")
      const id = `occ-${fingerprint([scope, input.triggerId, input.key]).slice(0, 32)}`
      const fencePosition = input.fence ? Number((this.db.prepare("SELECT COALESCE(MAX(position),0) AS n FROM commands WHERE conversation_id=?").get(input.fence.conversationId) as Row).n) : null
      const data = { key: input.key, action: input.action, grant: input.grant, request: input.request, inputs: received ? [received] : [], commandId: occurrenceCommandId(id), creationId: occurrenceCreationId(id), ...(input.guarded ? { guarded: true } : {}) }
      this.db.prepare("INSERT INTO trigger_occurrences(scope,id,trigger_id,kind,state,due_at,fence_conversation,fence_position,data,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)").run(scope, id, input.triggerId, input.kind, "scheduled", input.dueAt, input.fence?.conversationId ?? null, fencePosition, JSON.stringify(data), this.now(), this.now())
      this.db.prepare("INSERT INTO trigger_keys VALUES(?,?,?,?,?,?)").run(scope, input.triggerId, input.key, id, hash, this.now())
      this.triggerEvent("occurrence", scope, input.triggerId, id)
      return { occurrence: this.occurrence(scope, id)!, outcome: "created" }
    })
  }
  /**
   * Claims due occurrences of `kinds` for this lease, one at a time per
   * trigger: a trigger with an occurrence still being admitted or created
   * waits for it.
   */
  claimOccurrences(lease: DispatcherLease, kinds: readonly string[], limit = 20): ClaimedOccurrence[] {
    if (!kinds.length) return []
    return this.transaction(() => {
      if (!this.owns(lease)) return []
      const rows = this.db.prepare(`SELECT * FROM trigger_occurrences o WHERE state='scheduled' AND due_at<=? AND kind IN (${kinds.map(() => "?").join(",")}) AND NOT EXISTS (SELECT 1 FROM trigger_occurrences a WHERE a.scope=o.scope AND a.trigger_id=o.trigger_id AND a.state IN ${ACTIVE_OCCURRENCE}) ORDER BY due_at,created_at LIMIT ?`).all(this.now(), ...kinds, limit) as Row[]
      const claimed: ClaimedOccurrence[] = []
      const triggers = new Set<string>()
      for (const row of rows) {
        const key = JSON.stringify([row.scope, row.trigger_id])
        if (triggers.has(key)) continue
        triggers.add(key)
        this.db.prepare("UPDATE trigger_occurrences SET state='admitting',attempt=attempt+1,epoch=?,updated_at=? WHERE scope=? AND id=?").run(lease.epoch, this.now(), String(row.scope), String(row.id))
        this.triggerEvent("occurrence", String(row.scope), String(row.trigger_id), String(row.id))
        const occurrence = this.occurrence(String(row.scope), String(row.id))!
        claimed.push({ occurrence, attempt: occurrence.attempt, epoch: lease.epoch })
      }
      return claimed
    })
  }
  private claimCurrent(claim: ClaimedOccurrence, lease: DispatcherLease, states: readonly OccurrenceState[]): TriggerOccurrence | null {
    if (!this.owns(lease) || lease.epoch !== claim.epoch) return null
    const row = this.db.prepare("SELECT * FROM trigger_occurrences WHERE scope=? AND id=? AND attempt=? AND epoch=?").get(claim.occurrence.scope, claim.occurrence.id, claim.attempt, claim.epoch) as Row | undefined
    const occurrence = row && this.occurrenceRow(row)
    return occurrence && states.includes(occurrence.state) ? occurrence : null
  }
  /** Whether a claim still owns its occurrence; every write a claimed execution makes checks it first. */
  occurrenceCurrent(claim: ClaimedOccurrence, lease: DispatcherLease): boolean { return this.claimCurrent(claim, lease, ["admitting", "creating"]) !== null }
  /** Settles a claimed occurrence; false when another attempt or host owns it now. */
  finishOccurrence(claim: ClaimedOccurrence, lease: DispatcherLease, state: OccurrenceState, details: { reason?: string; hold?: OccurrenceHold; sessionId?: string; dueAt?: number } = {}): boolean {
    return this.transaction(() => {
      const current = this.claimCurrent(claim, lease, ["admitting", "creating"])
      if (!current) return false
      const { dueAt, ...patch } = details
      this.writeOccurrence(current, { hold: undefined, reason: undefined, ...patch }, state, dueAt ?? current.dueAt)
      return true
    })
  }
  /**
   * Marks a claimed occurrence as creating a session. From here a crash
   * leaves its creation operation to say what happened: no operation means
   * nothing started, one without a result means the outcome is unknown.
   */
  beginOccurrenceCreation(claim: ClaimedOccurrence, lease: DispatcherLease): boolean {
    return this.transaction(() => {
      const current = this.claimCurrent(claim, lease, ["admitting"])
      if (!current) return false
      this.writeOccurrence(current, {}, "creating")
      return true
    })
  }
  /**
   * Admits a claimed occurrence's durable command in the same transaction that
   * records it, so a crash leaves either both or neither. Refuses, cancelling
   * the occurrence, when someone else messaged its fenced conversation since
   * it was recorded.
   */
  admitForOccurrence(claim: ClaimedOccurrence, lease: DispatcherLease, conversationId: string, payload: Record<string, unknown>, intent: CommandIntent, expectedRevision?: number): CommandReceipt | null {
    return this.transaction(() => {
      const current = this.claimCurrent(claim, lease, ["admitting"])
      if (!current) return null
      const row = this.db.prepare("SELECT fence_conversation,fence_position FROM trigger_occurrences WHERE scope=? AND id=?").get(current.scope, current.id) as Row
      if (row.fence_conversation && this.intervened(String(row.fence_conversation), Number(row.fence_position))) {
        this.writeOccurrence(current, { reason: "Someone messaged the session after this was scheduled" }, "cancelled")
        return null
      }
      const conversation = this.conversation(conversationId)
      if (expectedRevision !== undefined && conversation?.revision !== expectedRevision) {
        this.writeOccurrence(current, { hold: "binding", reason: "The session moved to another provider binding; review this run before resuming it" }, "held")
        return null
      }
      const receipt = this.admit(current.scope, current.commandId, conversationId, { ...payload, trigger: { occurrenceId: current.id } }, intent)
      this.writeOccurrence(current, { sessionId: receipt.sessionId, hold: undefined, reason: undefined }, "admitted")
      return receipt
    })
  }
  private intervened(conversationId: string, position: number): boolean {
    return (this.db.prepare("SELECT payload FROM commands WHERE conversation_id=? AND position>?").all(conversationId, position) as Row[])
      .some((row) => { const payload = decode<Record<string, unknown>>(row.payload); return !payload.trigger && payload.notification !== true })
  }
  private cancelFenced(conversationId: string, reason: string): void {
    for (const row of this.db.prepare("SELECT scope,id FROM trigger_occurrences WHERE fence_conversation=? AND state IN ('scheduled','held','admitting')").all(conversationId) as Row[]) this.settleOccurrence(String(row.scope), String(row.id), "cancelled", { reason })
  }
  private settleOccurrence(scope: string, id: string, state: OccurrenceState, patch: Partial<TriggerOccurrence>): void {
    const occurrence = this.occurrence(scope, id)
    if (occurrence) this.writeOccurrence(occurrence, patch, state)
  }
  /**
   * Mirrors admitted occurrences' commands: a settled command settles its
   * occurrence, a held or uncertain one holds it or marks it unknown with the
   * command's reason, and one resumed from the queue makes it admitted again.
   */
  settleAdmittedOccurrences(): number {
    return this.transaction(() => {
      let changed = 0
      for (const row of this.db.prepare("SELECT * FROM trigger_occurrences WHERE state IN ('admitted','held','unknown')").all() as Row[]) {
        const occurrence = this.occurrenceRow(row)
        const command = occurrence.command
        if (!command) {
          if (occurrence.state !== "admitted") continue
          this.writeOccurrence(occurrence, { reason: "Its command no longer exists" }, "cancelled")
          changed++
          continue
        }
        const next: OccurrenceState = command.state === "completed" || command.state === "failed" || command.state === "cancelled" || command.state === "unknown" ? command.state
          : command.state === "held" ? "held" : "admitted"
        if (next === occurrence.state) continue
        const hold: OccurrenceHold = command.errorCode === "REAUTHORIZE" ? "reauthorize" : "review"
        this.writeOccurrence(occurrence, next === "admitted" ? { hold: undefined, reason: undefined } : { ...(next === "held" ? { hold } : {}), ...(command.error ? { reason: command.error } : {}) }, next)
        changed++
      }
      return changed
    })
  }
  /**
   * After another host's lease lapsed, reads what its claims left behind:
   * an admission either committed its command or never happened, and a
   * creation's operation says whether a session may exist.
   */
  private reconcileOccurrences(epoch: number): void {
    for (const row of this.db.prepare(`SELECT * FROM trigger_occurrences WHERE state IN ${ACTIVE_OCCURRENCE} AND epoch<?`).all(epoch) as Row[]) {
      const occurrence = this.occurrenceRow(row)
      if (occurrence.state === "admitting") {
        if (occurrence.command) this.writeOccurrence(occurrence, { sessionId: occurrence.command.sessionId }, "admitted")
        else this.writeOccurrence(occurrence, {}, "scheduled")
        continue
      }
      const operation = this.operation(occurrence.scope, occurrence.creationId)
      const sessionId = (operation?.result as { sessionId?: unknown } | undefined)?.sessionId
      if (!operation) this.writeOccurrence(occurrence, {}, "scheduled")
      else if (typeof sessionId === "string") this.writeOccurrence(occurrence, { sessionId }, "completed")
      else this.writeOccurrence(occurrence, { reason: "The host stopped while this run was starting a session. Check the project's sessions before marking it." }, "unknown")
    }
  }
  /** Cancels an occurrence that has not reached an agent yet, with its waiting command. */
  cancelOccurrence(scope: string, id: string, reason = "Cancelled"): TriggerOccurrence {
    return this.transaction(() => {
      const occurrence = this.occurrence(scope, id)
      if (!occurrence) throw new OrchestrationError(404, "Run not found")
      if (isTerminalOccurrence(occurrence.state)) return occurrence
      if (occurrence.state === "admitting" || occurrence.state === "creating") throw new OrchestrationError(409, "This run is being started; wait for it to settle")
      if (occurrence.state === "unknown") throw new OrchestrationError(409, "Resolve this run's unknown outcome instead")
      if (occurrence.state === "admitted") {
        const command = occurrence.command
        if (command && !["queued", "held"].includes(command.state)) throw new OrchestrationError(409, "Delivery has begun; stop the session's turn instead")
        if (command) this.cancel(scope, command.id)
      }
      this.writeOccurrence(occurrence, { hold: undefined, reason }, "cancelled")
      return this.occurrence(scope, id)!
    })
  }
  /**
   * Returns a held occurrence to the schedule, due now, optionally under a
   * renewed grant. One whose message was already admitted releases that same
   * message — its payload and fingerprint untouched — with the grant replacing
   * the occurrence's own, once the grant is checked to be the owner's, live,
   * and for exactly what the old one allowed.
   */
  requeueOccurrence(scope: string, id: string, grant?: GrantRef): TriggerOccurrence {
    return this.transaction(() => {
      const occurrence = this.occurrence(scope, id)
      if (!occurrence) throw new OrchestrationError(404, "Run not found")
      if (occurrence.state !== "held") throw new OrchestrationError(409, "Only a held run can be resumed")
      if (grant) this.checkReplacementGrant(scope, occurrence, grant)
      const command = occurrence.command && this.command(scope, occurrence.command.id)
      if (command) {
        if (command.receipt.state !== "held") throw new OrchestrationError(409, "This run's message is not held")
        if (this.conversation(command.receipt.conversationId)?.revision !== command.receipt.bindingRevision) throw new OrchestrationError(409, "The session moved to another provider binding; cancel this run instead")
        this.update(command, "queued", { error: undefined, errorCode: undefined })
        this.writeOccurrence(occurrence, { hold: undefined, reason: undefined, ...(grant ? { grant } : {}) }, "admitted")
        return this.occurrence(scope, id)!
      }
      this.writeOccurrence(occurrence, { hold: undefined, reason: undefined, ...(grant ? { grant } : {}) }, "scheduled", Math.min(occurrence.dueAt, this.now()))
      return this.occurrence(scope, id)!
    })
  }
  private checkReplacementGrant(scope: string, occurrence: TriggerOccurrence, ref: GrantRef): void {
    const grant = this.grant(ref.grantId)
    if (!grant || grant.revision !== ref.revision) throw new OrchestrationError(404, "Authorization not found")
    if (grant.scope !== scope) throw new OrchestrationError(403, "That authorization belongs to another account")
    if (grant.revokedAt || (grant.expiresAt !== undefined && grant.expiresAt <= this.now())) throw new OrchestrationError(409, "That authorization is no longer valid")
    if (!grant.actions.includes(occurrence.action)) throw new OrchestrationError(409, "That authorization does not allow this run")
    const previous = occurrence.grant && this.grant(occurrence.grant.grantId)
    const command = occurrence.command
    const sameTarget = previous
      ? fingerprint(previous.target) === fingerprint(grant.target)
      : !command || (grant.target.sessionId === command.sessionId && (grant.target.bindingRevision === undefined || grant.target.bindingRevision === command.bindingRevision))
    if (!sameTarget) throw new OrchestrationError(409, "That authorization is for a different target")
  }
  /** Holds a scheduled occurrence for review, such as one a missed-run policy will not start by itself. */
  holdOccurrence(scope: string, id: string, hold: OccurrenceHold, reason: string): TriggerOccurrence {
    return this.transaction(() => {
      const occurrence = this.occurrence(scope, id)
      if (!occurrence) throw new OrchestrationError(404, "Run not found")
      if (occurrence.state !== "scheduled") throw new OrchestrationError(409, "Only a waiting run can be held")
      this.writeOccurrence(occurrence, { hold, reason }, "held")
      return this.occurrence(scope, id)!
    })
  }
  /** Marks a scheduled occurrence skipped, such as a missed slot or an overlapping run. */
  skipOccurrence(scope: string, id: string, reason: string): TriggerOccurrence {
    return this.transaction(() => {
      const occurrence = this.occurrence(scope, id)
      if (!occurrence) throw new OrchestrationError(404, "Run not found")
      if (occurrence.state !== "scheduled") throw new OrchestrationError(409, "Only a waiting run can be skipped")
      this.writeOccurrence(occurrence, { reason }, "skipped")
      return this.occurrence(scope, id)!
    })
  }
  /** The user's answer to an occurrence whose session creation outcome is unknown. */
  resolveOccurrence(scope: string, id: string, disposition: "completed" | "failed", sessionId?: string): TriggerOccurrence {
    return this.transaction(() => {
      const occurrence = this.occurrence(scope, id)
      if (!occurrence || occurrence.state !== "unknown") throw new OrchestrationError(409, "Run is not awaiting reconciliation")
      this.writeOccurrence(occurrence, { reason: disposition === "failed" ? "Marked as not started" : "Marked as started", ...(sessionId ? { sessionId } : {}) }, disposition)
      return this.occurrence(scope, id)!
    })
  }
}
