import { useEffect, useState } from "react"
import { Badge } from "@/components/ui/badge"
import { parseTasksPage, type ClickUpTask, type GitHubActionsRun, type GitHubPullRequest, type VercelDeployment } from "@cogpit/plugin-integrations"
import type { PluginConnectionStatus, PluginIntegrationRequest, PluginIntegrationResult, PluginRequest } from "@cogpit/plugin-contracts"
import type { RuntimePluginClient } from "./runtimeClient"

export type RuntimeIndicatorClient = Pick<RuntimePluginClient, "lease" | "call" | "revokeLease">
export interface RuntimePluginIndicatorProps {
  client: RuntimeIndicatorClient
  pluginId: string
  projectId: string | null
  workspacePath: string | null
  activation: string
  registryRevision: number
  enabled?: boolean
}
interface Indicator { label: string; text: string; variant: "default" | "secondary" | "destructive"; compact?: boolean }
const COUNT_CLASS = "absolute -right-1 -top-1 min-w-4 px-1 text-[9px]"
const FAILURE_CLASS = "absolute -right-0.5 -top-0.5 size-3 p-0 text-[8px]"
const BUNDLED = new Set(["cogpit.github", "cogpit.vercel", "cogpit.clickup"])
const failedRun = new Set(["action_required", "failure", "startup_failure", "timed_out"])
const activeDeployment = new Set(["BUILDING", "INITIALIZING", "QUEUED"])
const failedDeployment = new Set(["BLOCKED", "CANCELED", "ERROR"])

function countIndicator(count: number, label: string, variant: Indicator["variant"] = "default"): Indicator | null {
  return count ? { text: String(count), label, variant } : null
}
function githubIndicator(runs: GitHubActionsRun[], pulls: GitHubPullRequest[]): Indicator | null {
  const active = runs.filter(run => run.status !== "completed").length
  if (active) return countIndicator(active, `${active} active GitHub Actions run${active === 1 ? "" : "s"}`)
  if (runs[0]?.conclusion && failedRun.has(runs[0].conclusion)) return { text: "!", label: "Latest GitHub Actions run failed", variant: "destructive", compact: true }
  const reviews = pulls.filter(pull => (pull.state === "open" || pull.state === "draft") && pull.reviewRequested).length
  return countIndicator(reviews, `${reviews} pull request${reviews === 1 ? "" : "s"} waiting for your review`, "secondary")
}
function vercelIndicator(deployments: VercelDeployment[]): Indicator | null {
  const active = deployments.filter(deployment => activeDeployment.has(deployment.state)).length
  if (active) return countIndicator(active, `${active} active Vercel deployment${active === 1 ? "" : "s"}`)
  return deployments[0] && failedDeployment.has(deployments[0].state)
    ? { text: "!", label: "Latest Vercel deployment failed", variant: "destructive", compact: true } : null
}
function clickupIndicator(tasks: ClickUpTask[]): Indicator | null {
  const today = new Date(); today.setHours(0, 0, 0, 0)
  const overdue = tasks.filter(task => task.status.type !== "closed" && task.dueAt !== null && task.dueAt < today.getTime()).length
  return countIndicator(overdue, `${overdue} overdue ClickUp task${overdue === 1 ? "" : "s"}`, "destructive")
}

type Call = (request: PluginRequest) => ReturnType<RuntimeIndicatorClient["call"]>
class IntegrationUnavailable extends Error {}
function createReader(pluginId: string) {
  let runs: GitHubActionsRun[] = []
  let pulls: GitHubPullRequest[] = []
  let pullsFetchedAt = -Infinity
  return async (call: Call, signal: AbortSignal): Promise<Indicator | null> => {
    let sequence = 0
    async function integration(input: PluginIntegrationRequest) {
      const result = await call({ protocol: 1, type: "request", id: `indicator-${++sequence}`, method: "integrations.request", params: input }) as PluginIntegrationResult
      signal.throwIfAborted()
      if (!result.ok) throw new IntegrationUnavailable("Integration unavailable")
      return result.data
    }
    if (pluginId === "cogpit.vercel") {
      const data = await integration({ integration: "vercel", operation: "deployments", limit: 20 }) as unknown as { deployments: VercelDeployment[] }
      return vercelIndicator(data.deployments)
    }
    if (pluginId === "cogpit.github") {
      const results = await Promise.allSettled([
        integration({ integration: "github", operation: "actions", limit: 20 }),
        Date.now() - pullsFetchedAt >= 30_000 ? integration({ integration: "github", operation: "pulls", limit: 30 }) : Promise.resolve(null),
      ])
      signal.throwIfAborted()
      for (const result of results) if (result.status === "rejected" && !(result.reason instanceof IntegrationUnavailable)) throw result.reason
      const [actions, reviews] = results
      if (actions.status === "fulfilled") runs = (actions.value as unknown as { runs: GitHubActionsRun[] }).runs
      if (reviews.status === "fulfilled" && reviews.value !== null) {
        pulls = (reviews.value as unknown as { pulls: GitHubPullRequest[] }).pulls
        pullsFetchedAt = Date.now()
      }
      return githubIndicator(runs, pulls)
    }
    const status = await call({ protocol: 1, type: "request", id: "indicator-status", method: "connections.status", params: { handle: "clickup" } }) as PluginConnectionStatus
    signal.throwIfAborted()
    if (!status.configured || !status.selected.workspace) return null
    const tasks = new Map<string, ClickUpTask>()
    for (let page = 0; page < 3; page++) {
      const result = parseTasksPage(await call({ protocol: 1, type: "request", id: `indicator-page-${page}`, method: "connections.request", params: { handle: "clickup", operationId: "mine", args: { page } } }))
      signal.throwIfAborted()
      for (const task of result.tasks) tasks.set(task.id, task)
      if (result.lastPage) break
    }
    return clickupIndicator([...tasks.values()])
  }
}

export function RuntimePluginIndicator({ client, pluginId, projectId, workspacePath, activation, registryRevision, enabled = true }: RuntimePluginIndicatorProps) {
  const identity = JSON.stringify([pluginId, projectId, workspacePath, activation, registryRevision, enabled])
  const [snapshot, setSnapshot] = useState<{ client: RuntimeIndicatorClient; identity: string; indicator: Indicator | null } | null>(null)
  useEffect(() => {
    if (!enabled || !activation || !BUNDLED.has(pluginId) || (pluginId !== "cogpit.clickup" && (!projectId || !workspacePath))) return
    const controller = new AbortController()
    const read = createReader(pluginId)
    const interval = pluginId === "cogpit.clickup" ? 60_000 : 10_000
    const epoch = Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, "0")).join("")
    let timer: ReturnType<typeof setTimeout> | undefined
    let leaseId: string | null = null
    let running = false
    function release() {
      const id = leaseId; leaseId = null
      if (id) void client.revokeLease(id).catch(() => {})
    }
    async function poll() {
      if (running || controller.signal.aborted) return
      if (document.visibilityState === "hidden") { timer = setTimeout(() => { void poll() }, interval); return }
      running = true
      const deadline = new AbortController()
      const deadlineAt = Date.now() + 20_000
      let timeout = setTimeout(() => { deadline.abort(); release() }, 20_000)
      const signal = AbortSignal.any([controller.signal, deadline.signal])
      try {
        const lease = await client.lease(pluginId, projectId, epoch, signal, workspacePath)
        leaseId = lease.id
        signal.throwIfAborted()
        const remaining = Math.min(deadlineAt, lease.expiresAt) - Date.now()
        if (remaining <= 0) throw new Error("Plugin lease expired")
        clearTimeout(timeout)
        timeout = setTimeout(() => { deadline.abort(); release() }, remaining)
        const indicator = await read(request => { signal.throwIfAborted(); return client.call(lease.id, request, signal) }, signal)
        signal.throwIfAborted()
        setSnapshot({ client, identity, indicator })
      } catch {
        if (!controller.signal.aborted) setSnapshot({ client, identity, indicator: null })
      } finally {
        clearTimeout(timeout)
        release()
        running = false
        if (!controller.signal.aborted) timer = setTimeout(() => { void poll() }, interval)
      }
    }
    function visible() {
      if (document.visibilityState === "visible" && !running) { clearTimeout(timer); void poll() }
    }
    void poll()
    document.addEventListener("visibilitychange", visible)
    return () => { controller.abort(); clearTimeout(timer); document.removeEventListener("visibilitychange", visible); release() }
  }, [client, pluginId, projectId, workspacePath, activation, registryRevision, enabled, identity])
  const indicator = snapshot?.client === client && snapshot.identity === identity ? snapshot.indicator : null
  return indicator ? <Badge variant={indicator.variant} className={indicator.compact ? FAILURE_CLASS : COUNT_CLASS} aria-label={indicator.label}>{indicator.text}</Badge> : null
}
