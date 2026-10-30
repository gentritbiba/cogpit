import { DRAFT_LIMITS, type DraftList, type DraftMethod, type DraftMethodMap, type DraftPreview } from "@cogpit/plugin-contracts"
import { activeComposer, addComposerKeyHandler, onComposerEvent, type ComposerHandle, type ComposerSnapshot } from "@/plugins/composerBridge"
import type { ClientIntegrationContext, DraftsIntegration } from "@/plugins/clientIntegrations"
import { deviceScopedKey } from "@/lib/device"
import { EMPTY_DRAFT, isDraftEmpty } from "../../../shared/session/composerContext"
import { canRecall, composerScope, draftStore, type DraftStore, type SavedDraft } from "./draftStore"

function failure(code: string, message: string): never { throw Object.assign(new Error(message), { code }) }
const encoder = new TextEncoder()
function excerpt(text: string, bytes: number): string {
  let value = text.slice(0, Math.min(DRAFT_LIMITS.previewChars, bytes))
  while (encoder.encode(value).length > bytes) value = value.slice(0, -1)
  return value
}
function preview(entry: SavedDraft): DraftPreview {
  return {
    id: entry.id, kind: entry.kind, savedAt: entry.savedAt, text: excerpt(entry.draft.text, 2000), textChars: entry.draft.text.length,
    context: entry.draft.context.slice(0, DRAFT_LIMITS.contextItems).map((item) => ({ kind: item.kind, label: excerpt(item.kind === "file" ? item.path : item.kind === "quote" ? "Quoted message" : item.kind === "browser" ? item.title || "Browser capture" : item.label || "Terminal", 128) })),
    images: entry.draft.attachments.slice(0, DRAFT_LIMITS.images).map((image) => ({ mediaType: image.mediaType, bytes: Math.floor(image.data.length * 3 / 4) - (image.data.endsWith("==") ? 2 : image.data.endsWith("=") ? 1 : 0) })),
  }
}
function download(store: DraftStore): void {
  const url = URL.createObjectURL(new Blob([store.backup()], { type: "application/json" }))
  const link = document.createElement("a")
  link.href = url; link.download = "cogpit-drafts-backup.json"; link.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

export function activate(context: ClientIntegrationContext): DraftsIntegration {
  if (context.pluginId !== "cogpit.saved-drafts") failure("CAPABILITY_UNAVAILABLE", "This integration is reserved for Saved drafts")
  context.signal.throwIfAborted()
  const owner = deviceScopedKey("composer-v1")
  const listeners = new Set<(token: string) => void>()
  const uploadingScopes = new Set<string>()
  const subscriptions = new Map<DraftStore, () => void>()
  const sends = new Map<string, { store: DraftStore; id: string; cwd: string | null; pendingIdentity: boolean; settled?: boolean }>()
  const backedUp = new Map<DraftStore, ReturnType<DraftStore["getSnapshot"]>>()
  let disposed = false
  let recalling: { scope: string; index: number; token: string } | null = null
  function authorized() {
    if (disposed || context.signal.aborted || owner !== deviceScopedKey("composer-v1")) failure("STALE_ACTIVATION", "Saved drafts is no longer active for this account and device")
  }
  function current(token?: string, idle = false) {
    authorized()
    const composer = activeComposer()
    if (!composer) failure("CAPABILITY_UNAVAILABLE", "Open a message composer to use Saved drafts")
    const snapshot = composer.snapshot()
    if (!context.inScope(snapshot.scope.cwd)) failure("CAPABILITY_UNAVAILABLE", "Saved drafts is not enabled for this project")
    if (snapshot.scope.key !== composerScope(snapshot.scope.cwd, snapshot.scope.identity) || (token !== undefined && token !== snapshot.token)) failure("STALE_ACTIVATION", "The composer changed. Refresh Saved drafts and try again")
    if (idle && snapshot.busy) failure("CONFLICT", "Wait for the image upload or send to finish")
    return { composer, snapshot, store: storeFor(snapshot) }
  }
  function notify() {
    if (disposed || context.signal.aborted || owner !== deviceScopedKey("composer-v1")) return
    const token = activeComposer()?.snapshot().token
    if (token) for (const listener of listeners) listener(token)
  }
  function storeFor(snapshot: ComposerSnapshot): DraftStore {
    authorized()
    if (!context.inScope(snapshot.scope.cwd)) failure("CAPABILITY_UNAVAILABLE", "Saved drafts is not enabled for this project")
    const store = draftStore(snapshot.scope.key)
    if (!subscriptions.has(store)) subscriptions.set(store, store.subscribe(notify))
    return store
  }
  function synchronize(composer: ComposerHandle, snapshot: ComposerSnapshot, hydrate: boolean) {
    const store = storeFor(snapshot)
    const saved = store.getSnapshot().record.draft
    if (hydrate && isDraftEmpty(snapshot.draft) && !isDraftEmpty(saved) && !snapshot.busy) {
      if (composer.replace(saved, snapshot.token)) return
    }
    store.saveDraft(snapshot.draft)
    if (snapshot.uploading) { uploadingScopes.add(snapshot.scope.key); if (!store.getSnapshot().record.pendingUpload) store.markUpload(true) }
    else if (uploadingScopes.delete(snapshot.scope.key)) store.markUpload(false)
  }
  function capture(token: string, clear: boolean): { id: string } {
    const { composer, snapshot, store } = current(token, true)
    store.saveDraft(snapshot.draft)
    const id = clear ? store.save(snapshot.draft) : store.copy(snapshot.draft)
    if (!id) failure("CONFLICT", store.getSnapshot().error || "The composer is empty")
    if (clear && !composer.replace(EMPTY_DRAFT, token)) {
      store.saveDraft(composer.snapshot().draft)
      failure("STALE_ACTIVATION", "The draft changed; its saved copy was kept")
    }
    recalling = null
    composer.focus()
    return { id }
  }
  const handlers: { [M in DraftMethod]: (params: DraftMethodMap[M]["params"]) => DraftMethodMap[M]["result"] } = {
    "drafts.list"({ cursor }) {
      const { snapshot, store } = current()
      const state = store.getSnapshot()
      const entries = [...state.record.entries].reverse()
      let start = 0
      if (cursor) {
        const found = entries.findIndex((entry) => entry.id === cursor)
        if (found < 0) failure("STALE_ACTIVATION", "The saved list changed. Refresh it")
        start = found + 1
      }
      const result: DraftList = { token: snapshot.token, items: [], ...(state.error ? { error: state.error.slice(0, 512) } : {}), corrupt: state.corrupt !== null, pendingUpload: Boolean(state.record.pendingUpload) }
      for (const entry of entries.slice(start, start + DRAFT_LIMITS.page)) {
        const item = preview(entry)
        if (encoder.encode(JSON.stringify({ ...result, items: [...result.items, item] })).length > 48_000) break
        result.items.push(item)
      }
      if (start + result.items.length < entries.length && result.items.length) result.next = result.items.at(-1)!.id
      return result
    },
    "drafts.capture": ({ token, clear }) => capture(token, clear),
    "drafts.restore"({ token, id, mode }) {
      const { composer, snapshot, store } = current(token, true)
      store.saveDraft(snapshot.draft)
      const restored = store.restore(id, mode)
      if (!restored) failure("CONFLICT", store.getSnapshot().error || "Your current draft has content. Choose Swap or Merge")
      if (!composer.replace(restored, token)) failure("STALE_ACTIVATION", "The composer changed; refresh before restoring")
      recalling = null; composer.focus()
      return null
    },
    "drafts.remove"({ token, id }) {
      const { store } = current(token, true)
      if (!store.remove(id)) failure("CONFLICT", store.getSnapshot().error || "The draft could not be deleted")
      return null
    },
    "drafts.backup"({ token }) {
      const { store } = current(token)
      download(store); backedUp.set(store, store.getSnapshot())
      return null
    },
    "drafts.recover"({ token, action }) {
      const { store } = current(token, true)
      if (action === "reset" && backedUp.get(store) !== store.getSnapshot()) failure("CONFLICT", "Download the current backup before resetting damaged storage")
      const ok = action === "retry" ? store.retry(context.inScope) : action === "reset" ? store.resetAfterBackup() : store.markUpload(false)
      if (!ok) failure("CONFLICT", store.getSnapshot().error || "Storage is unavailable")
      return null
    },
  }
  const stopEvents = onComposerEvent((event) => {
    authorized()
    if (event.type === "scope" || event.type === "change") {
      const composer = activeComposer()
      if (composer && context.inScope(event.snapshot.scope.cwd)) synchronize(composer, event.snapshot, event.type === "scope")
      if (recalling && recalling.token !== event.snapshot.token) recalling = null
      notify()
    } else if (event.type === "rejected-input") {
      if (!context.inScope(event.scope.cwd)) return
      draftStore(event.scope.key).retainImport(event.text)
      notify()
    } else if (event.type === "before-send") {
      if (!context.inScope(event.scope.cwd)) return
      recalling = null
      const store = draftStore(event.scope.key)
      const id = store.save(event.draft, "sending")
      if (id) sends.set(event.sendId, { store, id, cwd: event.scope.cwd, pendingIdentity: (JSON.parse(event.scope.identity) as [string, string])[1] === "pending" })
    } else if (event.type === "created") {
      const pending = sends.get(event.sendId)
      if (pending && context.inScope(pending.cwd)) { pending.store.created(pending.id, event.session, context.inScope); pending.pendingIdentity = false; if (pending.settled) sends.delete(event.sendId) }
    } else if (event.type === "settled") {
      const pending = sends.get(event.sendId)
      if (pending && context.inScope(pending.cwd)) { pending.store.settle(pending.id, event.sent, false, context.inScope); pending.settled = true; if (!event.sent || !pending.pendingIdentity) sends.delete(event.sendId) }
      notify()
    }
  })
  const stopKeys = addComposerKeyHandler((input, composer) => {
    authorized()
    const snapshot = composer.snapshot()
    if (!context.inScope(snapshot.scope.cwd)) return false
    if ((input.ctrlKey || input.metaKey) && input.shiftKey && !input.altKey && input.key.toLowerCase() === "s" && !input.isComposing) {
      try { capture(snapshot.token, true) } catch { notify() }
      return true
    }
    const isRecalling = recalling?.scope === snapshot.scope.key && recalling.token === snapshot.token
    if (snapshot.busy || !canRecall(input, input.selectionStart, input.selectionEnd, snapshot.draft, isRecalling, input.suggestionsOpen)) return false
    const history = storeFor(snapshot).getSnapshot().record.entries.filter((entry) => entry.kind === "sent").reverse()
    const index = isRecalling ? recalling!.index : null
    const next = input.key === "ArrowUp" ? Math.min((index ?? -1) + 1, history.length - 1) : Math.max((index ?? 0) - 1, -1)
    if (!history.length || (input.key === "ArrowDown" && index === null)) return false
    const restored = composer.replace(history[next]?.draft ?? EMPTY_DRAFT, snapshot.token)
    if (!restored) return false
    recalling = next < 0 ? null : { scope: snapshot.scope.key, index: next, token: restored.token }
    composer.focus()
    return true
  })
  function dispose() {
    if (disposed) return
    disposed = true; stopEvents(); stopKeys()
    for (const unsubscribe of subscriptions.values()) unsubscribe()
    subscriptions.clear(); listeners.clear(); sends.clear(); backedUp.clear()
    context.signal.removeEventListener("abort", dispose)
  }
  context.signal.addEventListener("abort", dispose, { once: true })
  const composer = activeComposer()
  if (composer && context.inScope(composer.snapshot().scope.cwd)) synchronize(composer, composer.snapshot(), true)
  return {
    async request<M extends DraftMethod>(method: M, params: DraftMethodMap[M]["params"], signal: AbortSignal): Promise<DraftMethodMap[M]["result"]> {
      authorized(); signal.throwIfAborted()
      return handlers[method](params)
    },
    onTokenChange(listener) { listeners.add(listener); return () => { listeners.delete(listener) } },
    dispose,
  }
}
