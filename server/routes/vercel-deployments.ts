import type { VercelIntegrationRequest } from "@cogpit/plugin-contracts"
import { sendJson, type UseFn } from "../http"
import { getPluginManager } from "../plugins/manager"
import { PluginAuthorizationError } from "../plugins/authorization"
import { executeVercelIntegration, mapVercelFailure, type VercelDeploymentDependencies } from "../plugins/integrations/vercel"
import { clampLimit } from "./apiValues"

export function registerVercelDeploymentRoutes(use: UseFn, dependencies?: VercelDeploymentDependencies): void {
  for (const operation of ["deployments", "buildLogs"] as const) {
    use(`/api/vercel-deployments${operation === "buildLogs" ? "/build-logs" : ""}`, async (req, res, next) => {
      if (req.method !== "GET") return next()
      const url = new URL(req.url || "", "http://localhost")
      if (url.pathname !== "/" && url.pathname !== "") return next()
      const input: VercelIntegrationRequest = operation === "deployments"
        ? { integration: "vercel", operation, limit: clampLimit(url.searchParams.get("limit"), 20, 30) }
        : { integration: "vercel", operation, deploymentId: url.searchParams.get("deploymentId") ?? "", limit: clampLimit(url.searchParams.get("limit"), 200, 500) }
      const manager = getPluginManager()
      if (!manager) return sendJson(res, 503, { error: "Plugin host is unavailable", code: "vercel_api_failed" })
      const abort = new AbortController()
      const disconnected = () => { if (!res.writableEnded) abort.abort() }
      req.once("aborted", disconnected); res.once("close", disconnected)
      try {
        const result = await manager.runLegacyIntegration(req, { pluginId: "cogpit.vercel", projectPath: url.searchParams.get("cwd") ?? "", signal: abort.signal }, input,
          dependencies ? (request, context) => {
            if (request.integration !== "vercel") throw new Error("Unexpected integration")
            return executeVercelIntegration(request, context, dependencies)
          } : undefined)
        if (!abort.signal.aborted) sendJson(res, 200, result)
      } catch (error) {
        if (abort.signal.aborted) return
        const detail = error instanceof PluginAuthorizationError ? error : mapVercelFailure(error)
        sendJson(res, detail.status, { error: detail.message, code: detail.code })
      } finally {
        req.removeListener("aborted", disconnected); res.removeListener("close", disconnected)
      }
    })
  }
}
