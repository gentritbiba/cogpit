import type { GitHubIntegrationRequest } from "@cogpit/plugin-contracts"
import { sendJson, type UseFn } from "../http"
import { getPluginManager } from "../plugins/manager"
import { executeGitHubIntegration, type GitHubDependencies } from "../plugins/integrations/github"
import { clampLimit } from "./apiValues"

export { ISSUES_QUERY, PULLS_QUERY, parseGitHubRemote, parseIssuesResponse, parseJobsResponse, parsePullFilesResponse, parsePullsResponse, parseRunsResponse, runGitHubApi } from "../plugins/integrations/github"

export function registerGitHubRoutes(use: UseFn, dependencies?: GitHubDependencies): void {
  const routes: [string, (url: URL) => GitHubIntegrationRequest][] = [
    ["actions", url => ({ integration: "github", operation: "actions", limit: clampLimit(url.searchParams.get("limit"), 20, 30) })],
    ["actions/jobs", url => ({ integration: "github", operation: "actionJobs", runId: Number(url.searchParams.get("runId")) })],
    ["pulls", url => ({ integration: "github", operation: "pulls", limit: clampLimit(url.searchParams.get("limit"), 30, 50) })],
    ["pulls/files", url => ({ integration: "github", operation: "pullFiles", number: Number(url.searchParams.get("number")) })],
    ["pulls/sessions", () => ({ integration: "github", operation: "pullSessions" })],
    ["issues", url => ({ integration: "github", operation: "issues", limit: clampLimit(url.searchParams.get("limit"), 30, 50) })],
  ]
  for (const [path, input] of routes) use(`/api/github/${path}`, async (req, res, next) => {
    if (req.method !== "GET") return next()
    const url = new URL(req.url || "", "http://localhost")
    if (url.pathname !== "/" && url.pathname !== "") return next()
    const controller = new AbortController()
    const abort = () => controller.abort()
    const close = () => { if (!res.writableFinished) abort() }
    req.once?.("aborted", abort); res.once?.("close", close)
    try {
      const manager = getPluginManager()
      if (!manager) { sendJson(res, 503, { error: "GitHub plugin is unavailable", code: "github_api_failed" }); return }
      const body = await manager.runLegacyIntegration(req, { pluginId: "cogpit.github", projectPath: url.searchParams.get("cwd") ?? "", signal: controller.signal }, input(url), dependencies ? (request, context) => {
        if (request.integration !== "github") throw new Error("Invalid integration")
        return executeGitHubIntegration(request, context, dependencies)
      } : undefined)
      sendJson(res, 200, body)
    } catch (error) {
      const failure = error as { status?: number; code?: string; message?: string }
      sendJson(res, failure.status ?? 500, { error: failure.status && failure.message ? failure.message : "Unable to load GitHub data", code: failure.code ?? "github_api_failed" })
    } finally { req.off?.("aborted", abort); res.off?.("close", close) }
  })
}
