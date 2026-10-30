import { beforeEach, describe, expect, it, vi } from "vitest"
import { __resetIdentityForTest, setActiveIdentity, recordDeviceConnectionRevision } from "@/lib/device"
import { canRecall, composerScope, DraftStore, MAX_ATTACHMENT_BYTES, resetDraftStoresForTest, mergeDrafts, validateDraft } from "../draftStore"
import { EMPTY_DRAFT, type ComposerDraft } from "../../../../shared/session/composerContext"

const draft = (text = "Keep me"): ComposerDraft => ({ v: 1, text, context: [{ id: "ctx-terminal1", kind: "terminal", text: "snapshot" }], attachments: [{ id: "image-1", mediaType: "image/png", data: "eA==" }] })
function storage() {
  const data = new Map<string, string>()
  return { getItem: vi.fn((key: string) => data.get(key) ?? null), setItem: vi.fn((key: string, value: string) => { data.set(key, value) }), removeItem: vi.fn(), clear: vi.fn(), key: vi.fn(), length: 0 }
}
beforeEach(() => { resetDraftStoresForTest(); __resetIdentityForTest(); window.history.replaceState(null, "", "/") })

describe("scoped durable composers", () => {
  it("isolates account, device revision, actual cwd/workspace and composer identity", () => {
    const keys = [composerScope("/repo", "session-a"), composerScope("/worktree", "session-a"), composerScope("/repo", "pending"), composerScope("/repo", "session-b")]
    setActiveIdentity("other-user")
    keys.push(composerScope("/repo", "session-a"))
    window.history.replaceState(null, "", "/d/device-a/")
    keys.push(composerScope("/repo", "session-a"))
    recordDeviceConnectionRevision("device-a", 123)
    keys.push(composerScope("/repo", "session-a"))
    expect(new Set(keys).size).toBe(keys.length)
  })
  it("roundtrips attachment bytes and snapshots through a fresh store with no File or preview URLs", () => {
    const disk = storage()
    const store = new DraftStore("a", () => disk)
    store.saveDraft(draft())
    const id = store.save(draft())!
    expect(store.getSnapshot().record.draft).toEqual(EMPTY_DRAFT)
    const reloaded = new DraftStore("a", () => disk)
    expect(reloaded.restore(id, "replace")).toEqual(draft())
    expect(disk.getItem("a")).not.toMatch(/blob:|"file":/)
  })
  it.each(["QuotaExceededError", "SecurityError"])("does not clear a draft or add a phantom stash when storage raises %s", (name) => {
    const disk = storage()
    const store = new DraftStore("a", () => disk)
    store.saveDraft(draft())
    disk.setItem.mockImplementation(() => { throw new DOMException("Denied", name) })
    expect(store.save(draft())).toBeNull()
    expect(store.getSnapshot().record.draft).toEqual(draft())
    expect(store.getSnapshot().record.entries).toEqual([])
    expect(store.getSnapshot().error).toMatch(/could not be saved/)
    disk.setItem.mockImplementation((key, value) => { void key; void value })
    expect(store.retry()).toBe(true)
    expect(store.getSnapshot().error).toBeNull()
  })
  it("survives a denied storage getter and allows exporting the in-memory draft", () => {
    const store = new DraftStore("a", () => { throw new DOMException("Denied", "SecurityError") })
    expect(store.saveDraft(draft())).toBe(false)
    expect(JSON.parse(store.backup()).draft).toEqual(draft())
    expect(store.getSnapshot().error).toMatch(/kept in this tab/)
  })
  it.each(["{broken", JSON.stringify({ v: 8 }), JSON.stringify({ v: 1, draft: { ...draft(), attachments: [{ id: "expired", url: "blob:expired" }] }, entries: [] })])("retains damaged/expired storage and current typing until explicit backup/reset", (raw) => {
    const disk = storage(); disk.setItem("a", raw)
    const store = new DraftStore("a", () => disk)
    store.saveDraft(draft("new typing"))
    expect(disk.getItem("a")).toBe(raw)
    expect(store.save(draft())).toBeNull()
    expect(store.getSnapshot().record.draft.text).toBe("new typing")
    expect(JSON.parse(store.backup()).damagedStorage).toBe(raw)
    expect(store.resetAfterBackup()).toBe(true)
    expect(new DraftStore("a", () => disk).getSnapshot().record.draft.text).toBe("new typing")
  })
  it("preserves refused bytes separately when newer text or attachments exist", () => {
    const disk = storage(); const store = new DraftStore("a", () => disk)
    const id = store.save(draft("first"), "sending")!
    store.saveDraft(draft("second")); store.settle(id, false)
    const reloaded = new DraftStore("a", () => disk)
    expect(reloaded.getSnapshot().record.draft.text).toBe("second")
    expect(reloaded.getSnapshot().record.entries[0]).toMatchObject({ kind: "refused", draft: draft("first") })
    expect(reloaded.restore(id, "replace")).toBeNull()
    expect(reloaded.restore(id, "swap")).toEqual(draft("first"))
    expect(reloaded.getSnapshot().record.entries[0].draft.text).toBe("second")
  })
  it("restores a refusal to an empty composer, including after it unmounted", () => {
    const disk = storage(); const store = new DraftStore("a", () => disk)
    const id = store.save(draft(), "sending")!; store.settle(id, false)
    expect(new DraftStore("a", () => disk).getSnapshot().record.draft).toEqual(draft())
    expect(store.getSnapshot().record.entries).toEqual([])
  })
  it("leaves a crashed send explicitly unconfirmed, and recalls only confirmed composer sends", () => {
    const disk = storage(); const store = new DraftStore("a", () => disk)
    store.save(draft("uncertain"), "sending")
    const id = store.save(draft("sent"), "sending")!; store.settle(id, true)
    store.save(draft("saved"))
    expect(new DraftStore("a", () => disk).getSnapshot().record.entries.map((entry) => entry.kind)).toEqual(["sending", "sent", "stash"])
  })
  it("merges snapshots and images without dropping either draft; rejects bounds/conflicts", () => {
    expect(mergeDrafts(draft("one"), draft("two"))).toEqual(draft("one\n\ntwo"))
    expect(() => mergeDrafts(draft(), { ...draft(), attachments: [{ ...draft().attachments[0], data: "eQ==" }] })).toThrow(/changed/)
    expect(() => mergeDrafts(draft(), { ...draft(), context: [{ id: "ctx-other123", kind: "terminal", text: "x".repeat(20_001) }] })).toThrow(/longer/)
  })
  it("enforces encoded attachment limits and missing browser bytes on restoration", () => {
    expect(() => validateDraft({ ...draft(), attachments: [{ ...draft().attachments[0], data: "a".repeat(MAX_ATTACHMENT_BYTES + 4) }] })).toThrow()
    expect(() => validateDraft({ ...draft(), attachments: [{ ...draft().attachments[0], data: "blob:expired" }] })).toThrow()
  })
  it("retains interrupted upload status across reload", () => {
    const disk = storage(); const store = new DraftStore("a", () => disk)
    store.markUpload(true)
    expect(new DraftStore("a", () => disk).getSnapshot().record.pendingUpload).toBe(true)
    store.markUpload(false)
    expect(new DraftStore("a", () => disk).getSnapshot().record.pendingUpload).toBe(false)
  })
  it("deletes durably and bounds only sent recall history, never unsent stashes", () => {
    const disk = storage(); const store = new DraftStore("a", () => disk)
    const stash = store.save(draft())!
    for (let n = 0; n < 35; n++) { const id = store.save(draft(String(n)), "sending")!; store.settle(id, true) }
    expect(store.getSnapshot().record.entries).toHaveLength(31)
    expect(store.remove(stash)).toBe(true)
    expect(new DraftStore("a", () => disk).getSnapshot().record.entries).toHaveLength(30)
  })
})

describe("recall keys", () => {
  const key = { key: "ArrowUp", shiftKey: false, ctrlKey: false, metaKey: false, altKey: false, isComposing: false }
  it("starts only in an empty composer and leaves ordinary draft editing alone", () => {
    expect(canRecall(key, 0, 0, EMPTY_DRAFT, false, false)).toBe(true)
    expect(canRecall(key, 0, 0, draft(), false, false)).toBe(false)
    expect(canRecall(key, 7, 7, draft(), true, false)).toBe(true)
    expect(canRecall(key, 0, 0, draft(), true, false)).toBe(false)
  })
  it("does not take selection, modified movement, IME or suggestion navigation", () => {
    for (const field of ["shiftKey", "ctrlKey", "metaKey", "altKey", "isComposing"]) expect(canRecall({ ...key, [field]: true }, 0, 0, EMPTY_DRAFT, false, false)).toBe(false)
    expect(canRecall(key, 0, 1, EMPTY_DRAFT, true, false)).toBe(false)
    expect(canRecall(key, 0, 0, EMPTY_DRAFT, false, true)).toBe(false)
  })
})

it.each(["before", "after"])("hands only the accepted first entry to its actual session when callback arrives %s settlement", (ordering) => {
  localStorage.clear()
  const originKey = composerScope("/pending", JSON.stringify(["pending-project", "pending"]))
  const origin = new DraftStore(originKey)
  const identity = { sessionId: "accepted-session", cwd: "/actual-worktree", dirName: "actual-project" }
  const targetKey = composerScope(identity.cwd, JSON.stringify([identity.dirName, identity.sessionId]))
  const target = new DraftStore(targetKey)
  target.saveDraft(draft("target typing"))
  origin.saveDraft(draft("first prompt"))
  const id = origin.save(draft("first prompt"), "sending")!
  origin.saveDraft(draft("new pending typing"))
  if (ordering === "before") origin.created(id, identity)
  origin.settle(id, true)
  if (ordering === "after") origin.created(id, identity)
  origin.created(id, identity); origin.settle(id, true)
  const reloaded = new DraftStore(targetKey)
  expect(reloaded.getSnapshot().record.draft.text).toBe("target typing")
  expect(reloaded.getSnapshot().record.entries).toHaveLength(1)
  expect(reloaded.getSnapshot().record.entries[0]).toMatchObject({ id, kind: "sent", draft: draft("first prompt") })
  expect(origin.getSnapshot().record.draft.text).toBe("new pending typing")
  expect(origin.getSnapshot().record.entries).toEqual([])
})

it("rolls back a quota-failed swap or deletion before retry, preserving both complete drafts", () => {
  const disk = storage(); const store = new DraftStore("a", () => disk)
  const id = store.save(draft("saved"))!
  store.saveDraft(draft("current"))
  const before = structuredClone(store.getSnapshot().record)
  disk.setItem.mockImplementation(() => { throw new DOMException("full", "QuotaExceededError") })
  expect(store.restore(id, "swap")).toBeNull()
  expect(store.getSnapshot().record).toEqual(before)
  expect(store.remove(id)).toBe(false)
  expect(store.getSnapshot().record).toEqual(before)
})
