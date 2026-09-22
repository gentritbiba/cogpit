import { randomBytes } from "node:crypto"
import { realpath } from "node:fs/promises"
import type { GitHubPullSessionsResponse } from "../../shared/contracts/github"
import { resolveSessionFilePath } from "../sessionPaths"
import { getSessionMeta } from "../sessionMetadata"
import { storeForDirName } from "../agents"
import type { PluginLease } from "./leases"
import { PluginDataError } from "./privateStore"

interface SessionAddress { dirName: string; fileName: string; sessionId: string }
const unavailable = (): never => { throw new PluginDataError("STALE_ACTIVATION", "This session is no longer available in the selected workspace") }

export class PluginSessionNavigation {
  private readonly handles = new WeakMap<AbortSignal, Map<string, SessionAddress>>()

  private handlesFor(lease: PluginLease): Map<string, SessionAddress> {
    let handles = this.handles.get(lease.signal)
    if (!handles) {
      handles = new Map()
      this.handles.set(lease.signal, handles)
      const issued = handles
      lease.signal.addEventListener("abort", () => issued.clear(), { once: true })
    }
    return handles
  }

  /** The handle already issued for this session on the lease, or a fresh one. */
  private handleFor(handles: Map<string, SessionAddress>, address: SessionAddress): string {
    for (const [handle, saved] of handles) {
      if (saved.dirName === address.dirName && saved.fileName === address.fileName && saved.sessionId === address.sessionId) return handle
    }
    const handle = `s_${randomBytes(24).toString("hex")}`
    if (handles.size >= 256) handles.delete(handles.keys().next().value!)
    handles.set(handle, { dirName: address.dirName, fileName: address.fileName, sessionId: address.sessionId })
    return handle
  }

  present(lease: PluginLease, value: GitHubPullSessionsResponse) {
    if (lease.signal.aborted) return unavailable()
    const handles = this.handlesFor(lease)
    return { repository: value.repository, pending: value.pending, sessions: value.sessions.slice(0, 200).map(session => ({
      handle: this.handleFor(handles, session), title: session.title, numbers: session.numbers,
    })) }
  }

  /**
   * The handle the open chat session carries in `present`, so a plugin can
   * recognise it among related sessions. Issued only for a transcript that
   * lives in the lease's workspace, with the same identity rule `resolve` checks.
   * The client may name a transcript by an id placeholder; the handle is keyed
   * by the inventory's own address so it matches the listing.
   */
  async presentCurrent(lease: PluginLease, address: { dirName: string; fileName: string }, authorize: () => Promise<void>): Promise<{ handle: string }> {
    await authorize()
    if (!lease.workspacePath || lease.signal.aborted) return unavailable()
    try {
      const path = await resolveSessionFilePath(address.dirName, address.fileName)
      if (!path) return unavailable()
      const store = storeForDirName(address.dirName)
      const canonical = await store.sessionAddress(path)
      if (!canonical) return unavailable()
      const meta = await getSessionMeta(path)
      if (!meta.cwd || await realpath(meta.cwd) !== lease.workspacePath) return unavailable()
      const sessionId = store.descriptor.sessionFile.sessionId(canonical.fileName) ?? meta.sessionId
      if (!sessionId) return unavailable()
      await authorize()
      if (lease.signal.aborted) return unavailable()
      return { handle: this.handleFor(this.handlesFor(lease), { dirName: canonical.dirName, fileName: canonical.fileName, sessionId }) }
    } catch { return unavailable() }
  }

  async resolve(lease: PluginLease, handle: string, authorize: () => Promise<void>): Promise<{ dirName: string; fileName: string }> {
    await authorize()
    const address = this.handles.get(lease.signal)?.get(handle)
    if (!address || !lease.workspacePath || lease.signal.aborted) return unavailable()
    try {
      const path = await resolveSessionFilePath(address.dirName, address.fileName)
      if (!path) return unavailable()
      const canonicalPath = await realpath(path)
      const meta = await getSessionMeta(path)
      const sessionId = storeForDirName(address.dirName).descriptor.sessionFile.sessionId(address.fileName) ?? meta.sessionId
      if (!meta.cwd || await realpath(meta.cwd) !== lease.workspacePath || sessionId !== address.sessionId) return unavailable()
      if (await resolveSessionFilePath(address.dirName, address.fileName) !== path || await realpath(path) !== canonicalPath) return unavailable()
      await authorize()
      if (lease.signal.aborted) return unavailable()
      return { dirName: address.dirName, fileName: address.fileName }
    } catch { return unavailable() }
  }
}
