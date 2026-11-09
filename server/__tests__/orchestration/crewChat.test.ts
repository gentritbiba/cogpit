// @vitest-environment node
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { expect, it } from "vitest"
import { OrchestrationStore } from "../../orchestration/store"

it("migrates a version 3 database and persists history, subscriptions, cursors and pending deliveries", () => {
  const root = mkdtempSync(join(tmpdir(), "cogpit-chat-store-"))
  const path = join(root, "state.sqlite")
  const legacy = new DatabaseSync(path)
  legacy.exec("PRAGMA user_version=3")
  legacy.close()
  let store = new OrchestrationStore(path)
  try {
    const message = store.postChat("owner", "persistent-chat-001", { rootId: "lead", author: { kind: "agent", name: "Parser", sessionId: "parser" }, text: "Finding", mentions: ["review"] }, [{ sessionId: "review", kind: "mention" }])
    store.setChatListening("lead", "review", false)
    store.setChatCursor("lead", "review", message.sequence)
    store.close()
    store = new OrchestrationStore(path)
    expect(store.chatMessages("lead", { limit: 100 })).toEqual([message])
    expect(store.chatListener("lead", "review")).toEqual({ listening: false, cursor: message.sequence })
    expect(store.chatDeliveries("lead", "owner")).toEqual([expect.objectContaining({ sessionId: "review", kind: "mention", state: "pending", attempts: 0, nextAttemptAt: 0 })])
    expect(store.chatDeliveries("lead", "other-owner")).toEqual([])
  } finally { store.close(); rmSync(root, { recursive: true, force: true }) }
})

it("adds attempt tracking to a version 5 database that already holds pending deliveries", () => {
  const root = mkdtempSync(join(tmpdir(), "cogpit-chat-store-"))
  const path = join(root, "state.sqlite")
  const legacy = new DatabaseSync(path)
  legacy.exec(`
    CREATE TABLE crew_chat_messages(sequence INTEGER PRIMARY KEY AUTOINCREMENT,root_id TEXT NOT NULL,scope TEXT NOT NULL,id TEXT NOT NULL,fingerprint TEXT NOT NULL,data TEXT NOT NULL,UNIQUE(scope,id));
    CREATE TABLE crew_chat_deliveries(sequence INTEGER NOT NULL REFERENCES crew_chat_messages(sequence) ON DELETE CASCADE,session_id TEXT NOT NULL,scope TEXT NOT NULL,kind TEXT NOT NULL,state TEXT NOT NULL DEFAULT 'pending',error TEXT,PRIMARY KEY(sequence,session_id));
    INSERT INTO crew_chat_messages(root_id,scope,id,fingerprint,data) VALUES('lead','owner','legacy-chat-0001','x','{"id":"legacy-chat-0001","rootId":"lead","author":{"kind":"user","name":"You"},"text":"Old","mentions":[],"createdAt":1}');
    INSERT INTO crew_chat_deliveries(sequence,session_id,scope,kind,error) VALUES(1,'review','owner','notification','Crew member is unavailable');
    PRAGMA user_version=5;
  `)
  legacy.close()
  const store = new OrchestrationStore(path)
  try {
    expect(store.dueChatDeliveries("lead", "owner", 0)).toEqual([expect.objectContaining({ sessionId: "review", state: "pending", error: "Crew member is unavailable", attempts: 0, nextAttemptAt: 0 })])
  } finally { store.close(); rmSync(root, { recursive: true, force: true }) }
})
