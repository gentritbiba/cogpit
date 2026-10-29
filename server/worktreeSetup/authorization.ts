import type { IncomingMessage } from "node:http"
import { refreshExecutionRequest } from "../lib/durableSend"
import { editionModule } from "../edition"
import { RouteError, ErrorCodes } from "../lib/routeError"

export function assertSetupAccess(req: IncomingMessage): void {
  const fresh = refreshExecutionRequest(req)
  const capabilities = fresh && editionModule().me(fresh).capabilities
  if (!capabilities?.hostFiles || !capabilities.terminal) throw new RouteError(403, ErrorCodes.FORBIDDEN, "Current host-file and terminal access is required for worktree setup")
}
