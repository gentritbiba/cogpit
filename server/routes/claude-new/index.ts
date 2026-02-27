import type { UseFn } from "../../helpers"
import { registerNewSessionRoute, registerCreateAndSendRoute } from "./sessionSpawner"
import { registerBranchSessionRoute } from "./sessionBranching"

// ── Re-exports ─────────────────────────────────────────────────────────

export { buildStreamMessage, resolveProjectPath } from "./sessionSpawner"
export { findTruncationLine } from "./sessionBranching"

// ── Route registration ────────────────────────────────────────────────

export function registerClaudeNewRoutes(use: UseFn) {
  registerNewSessionRoute(use)
  registerCreateAndSendRoute(use)
  registerBranchSessionRoute(use)
}
