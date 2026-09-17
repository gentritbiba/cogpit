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

  present(lease: PluginLease, value: GitHubPullSessionsResponse) {
    if (lease.signal.aborted) return unavailable()
    let handles = this.handles.get(lease.signal)
    if (!handles) {
      handles = new Map()
      this.handles.set(lease.signal, handles)
      const issued = handles
      lease.signal.addEventListener("abort", () => issued.clear(), { once: true })
    }
    return { repository: value.repository, pending: value.pending, sessions: value.sessions.slice(0, 200).map(session => {
      let handle = [...handles].find(([, saved]) => saved.dirName === session.dirName && saved.fileName === session.fileName && saved.sessionId === session.sessionId)?.[0]
      if (!handle) {
        handle = `s_${randomBytes(24).toString("hex")}`
        if (handles.size >= 256) handles.delete(handles.keys().next().value!)
        handles.set(handle, { dirName: session.dirName, fileName: session.fileName, sessionId: session.sessionId })
      }
      return { handle, title: session.title, numbers: session.numbers }
    }) }
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
