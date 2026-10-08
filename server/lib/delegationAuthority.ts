import type { IncomingMessage } from "node:http"
import { accessLevelOf } from "../edition"
import { accessAtLeast } from "../../shared/contracts/sessionAccess"
import { hostForSession } from "../sessionHosts"
import { attachTaskAuthority, type TaskAuthority } from "../orchestration/delegatedTasks"
import { commandScope, refreshExecutionRequest } from "./durableSend"
export function delegationAuthority(req: IncomingMessage, access: "view" | "interact" = "interact"): TaskAuthority {
  return {
    async authorize(id) { const fresh = refreshExecutionRequest(req); if (!fresh) return false; const level = await accessLevelOf(fresh, id); return level !== null && accessAtLeast(level, access) },
    async host(id) { const fresh = refreshExecutionRequest(req); if (!fresh) throw new Error("Delegation authority expired"); const host = await hostForSession(id); return { state: (sid) => host.state(sid), result: (sid) => host.result(sid), stop: (sid) => host.stop(sid), send: (sid, message, options) => host.send(sid, message, { ...options, req: fresh }) } },
  }
}
export function resumeDelegations(req: IncomingMessage, parentSessionId: string) { attachTaskAuthority(commandScope(req), parentSessionId, delegationAuthority(req)) }
