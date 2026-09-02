import type { UseFn } from "../../http"
import { registerBranchSessionRoute } from "./sessionBranching"
import { registerCreateAndSendRoute, registerNewSessionRoute } from "./sessionSpawner"

/** The routes that bring a session into existence, for every agent. */
export function registerSessionNewRoutes(use: UseFn) {
  registerNewSessionRoute(use)
  registerCreateAndSendRoute(use)
  registerBranchSessionRoute(use)
}
