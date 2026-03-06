import type { UseFn } from "../../helpers"
import { registerNewSessionRoute, registerCreateAndSendRoute } from "./sessionSpawner"
import { registerBranchSessionRoute } from "./sessionBranching"

export function registerClaudeNewRoutes(use: UseFn) {
  registerNewSessionRoute(use)
  registerCreateAndSendRoute(use)
  registerBranchSessionRoute(use)
}
