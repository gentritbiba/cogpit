import type { Middleware } from "../http"
import { clientSurface, requestPath } from "./events"
import { recordTelemetry } from "./index"

/**
 * Requests that mean a person used a feature, counted as `feature.used` once
 * they succeed. Only the fixed feature name leaves: the path's ids never do.
 * Polling and reads are left out, since they count screens open, not use.
 */
const ROUTE_FEATURES: ReadonlyArray<readonly [method: string, path: RegExp, feature: string]> = [
  ["POST", /^\/api\/branch-session$/, "session.branch"],
  ["POST", /^\/api\/conversation-transition$/, "session.handoff"],
  ["POST", /^\/api\/interrupt-session$/, "turn.interrupt"],
  ["POST", /^\/api\/stop-session$/, "session.stop"],
  ["POST", /^\/api\/archive-sessions$/, "session.archive"],
  ["POST", /^\/api\/delete-session$/, "session.delete"],
  ["POST", /^\/api\/kill-all$/, "agents.stop_all"],
  ["POST", /^\/api\/permissions\/[^/]+\/respond$/, "permission.answer"],
  ["POST", /^\/api\/permissions\/[^/]+\/respond-all$/, "permission.answer_all"],
  ["POST", /^\/api\/permissions\/[^/]+\/plan$/, "plan.answer"],
  ["POST", /^\/api\/ask-user-answer$/, "question.answer"],
  ["POST", /^\/api\/open-in-editor$/, "editor.open"],
  ["POST", /^\/api\/open-terminal$/, "terminal.open_external"],
  ["POST", /^\/api\/reveal-in-folder$/, "folder.reveal"],
  ["POST", /^\/api\/shares$/, "share.create"],
  ["POST", /^\/api\/undo\/transaction$/, "undo.apply"],
  ["POST", /^\/api\/voice\/transcribe$/, "voice.dictate"],
  ["POST", /^\/api\/voice\/speech$/, "voice.speak"],
  ["POST", /^\/api\/hub\/devices$/, "device.add"],
  ["POST", /^\/api\/provider-updates\/run$/, "agent.update"],
  ["POST", /^\/api\/kill-port$/, "port.kill"],
  ["POST", /^\/api\/worktrees\/[^/]+\/create-pr$/, "worktree.create_pr"],
  ["DELETE", /^\/api\/worktrees\/[^/]+$/, "worktree.delete"],
  ["POST", /^\/api\/worktrees\/[^/]+\/cleanup$/, "worktree.cleanup"],
  ["POST", /^\/api\/automations$/, "automation.create"],
  ["PUT", /^\/api\/automations\/[^/]+$/, "automation.update"],
  ["DELETE", /^\/api\/automations\/[^/]+$/, "automation.delete"],
  ["POST", /^\/api\/elicitation-answer$/, "elicitation.answer"],
  ["POST", /^\/api\/user-dialog-answer$/, "dialog.answer"],
  ["POST", /^\/api\/workflow-stop$/, "workflow.stop"],
  ["POST", /^\/api\/team-message$/, "team.message"],
  ["POST", /^\/api\/kill-process$/, "process.kill"],
  ["DELETE", /^\/api\/library\/items\/\d+$/, "library.remove"],
  ["POST", /^\/api\/config$/, "settings.save"],
  ["PUT", /^\/api\/appearance$/, "appearance.change"],
  ["POST", /^\/api\/config-browser\/file$/, "config_file.save"],
  ["POST", /^\/api\/config-browser\/create$/, "config_file.create"],
]

export function routeFeature(method: string | undefined, path: string): string | undefined {
  return ROUTE_FEATURES.find(([m, pattern]) => m === method && pattern.test(path))?.[2]
}

/** Mounted ahead of every API route; records a feature once its request succeeds. */
export const telemetryFeatures: Middleware = (req, res, next) => {
  const feature = routeFeature(req.method, requestPath(req))
  if (feature) {
    res.once("finish", () => {
      if (res.statusCode < 400) recordTelemetry("feature.used", { feature, client: clientSurface(req) })
    })
  }
  next()
}
