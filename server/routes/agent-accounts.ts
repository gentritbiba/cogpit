import { mayActHostWide, markDecided } from "../edition"
import { orchestrationStore } from "../orchestration/storage"
import { createProviderInstance, providerSetupCommand } from "../agents/instanceConfigurations"
import { runtimeFor } from "../agents/runtimes"
import { removeInstanceRuntime } from "../agents/instanceRuntimes"
import { sendAgentError } from "./agentErrors"
import { AGENT_KINDS, type AgentKind } from "../../shared/session/agent-descriptors"
import { accountSwitcherFor } from "../agents/accounts"
import { sendJson, withJsonBody, type UseFn } from "../http"

/**
 * GET  /api/agent-accounts/:kind         — logins the agent's switcher manages
 *                                          and which one is live.
 * POST /api/agent-accounts/:kind/switch  — `{ slot }` makes that login live.
 *
 * 404 for agents without a switcher. The body only ever names a slot from the
 * list; the command itself is Cogpit's.
 */
export function registerAgentAccountRoutes(use: UseFn) {
  use("/api/provider-instances", async (req, res, next) => {
    if (req.method === "GET") {
      markDecided(req)
      const administer = mayActHostWide(req)
      const instances = orchestrationStore().instances().map((instance) => administer ? { ...instance, setupCommand: providerSetupCommand(instance) } : { id: instance.id, agent: instance.agent, label: instance.label, retired: instance.retired })
      return sendJson(res, 200, { instances, administer })
    }
    if (req.method !== "POST") return next()
    if (!mayActHostWide(req)) return sendJson(res, 403, { error: "Only a host administrator can configure executables and accounts" })
    markDecided(req)
    withJsonBody<Record<string, unknown>>(req, res, async (body) => {
      try {
        if (body.action === "create") return sendJson(res, 201, { instance: await createProviderInstance(body) })
        const instance = orchestrationStore().instances().find((value) => value.id === body.instanceId)
        if (!instance) return sendJson(res, 404, { error: "Provider instance not found" })
        if (body.action === "restore") { orchestrationStore().putInstance({ ...instance, retired: false }); return sendJson(res, 200, { success: true }) }
        const runtime = runtimeFor(instance.agent, instance.id)
        if (body.action === "runtime") return sendJson(res, 200, { runtime: await runtime.describeRuntime(true), models: await runtime.listModels() })
        if (body.action !== "remove") return sendJson(res, 400, { error: "Unknown instance action" })
        if (runtime.isBusy?.() || runtime.listActive().length || runtime.listPendingApprovals().length || orchestrationStore().pending().some((command) => orchestrationStore().conversation(command.receipt.conversationId)?.binding.instanceId === instance.id)) return sendJson(res, 409, { error: "Finish or cancel this instance’s work before removing it" })
        orchestrationStore().putInstance({ ...instance, retired: true })
        await removeInstanceRuntime(instance.id)
        sendJson(res, 200, { success: true, retainedHistory: true })
      } catch (error) { sendAgentError(res, error, "Provider setup failed") }
    })
  })
  use("/api/agent-accounts", async (req, res, next) => {
    const segments = new URL(req.url || "/", "http://localhost").pathname.split("/").filter(Boolean)
    const [kind, action, ...rest] = segments
    if (!(AGENT_KINDS as readonly string[]).includes(kind ?? "") || rest.length > 0) return next()
    const switcher = accountSwitcherFor(kind as AgentKind)

    if (action === undefined && req.method === "GET") {
      if (!switcher) {
        sendJson(res, 404, { error: `${kind} has no account switcher` })
        return
      }
      try {
        sendJson(res, 200, await switcher.describe())
      } catch (err) {
        sendJson(res, 500, { error: String(err) })
      }
      return
    }

    if (action === "switch" && req.method === "POST") {
      if (!switcher) {
        sendJson(res, 404, { error: `${kind} has no account switcher` })
        return
      }
      withJsonBody<{ slot?: unknown }>(req, res, async (body) => {
        const slot = body?.slot
        if (typeof slot !== "number" || !Number.isInteger(slot) || slot <= 0) {
          sendJson(res, 400, { error: "slot must be a positive integer" })
          return
        }
        try {
          sendJson(res, 200, await switcher.switchTo(slot))
        } catch (err) {
          sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) })
        }
      })
      return
    }

    next()
  })
}
