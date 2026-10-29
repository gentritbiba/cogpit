import type { IncomingMessage } from "node:http"
import { refreshExecutionRequest } from "../lib/durableSend"
import { editionModule } from "../edition"
import { RouteError, ErrorCodes } from "../lib/routeError"

export function assertSetupAccess(req: IncomingMessage): void {
  const fresh = refreshExecutionRequest(req)
  if (!fresh) throw setupRefusal()
  assertSetupCapabilities(fresh)
}

/**
 * The setup-command policy for a request already resolved as current: a live
 * sign-in just refreshed, or the request an unattended grant was resolved to
 * for this execution.
 */
export function assertSetupCapabilities(current: IncomingMessage): void {
  const capabilities = editionModule().me(current).capabilities
  if (!capabilities.hostFiles || !capabilities.terminal) throw setupRefusal()
}

function setupRefusal(): RouteError {
  return new RouteError(403, ErrorCodes.FORBIDDEN, "Current host-file and terminal access is required for worktree setup")
}
