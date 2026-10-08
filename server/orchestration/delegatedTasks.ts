import type { CommandReceipt, DelegatedTask } from "../../shared/contracts/orchestration"
import { formatTaskWakeup } from "../../shared/contracts/taskWakeup"
import { beforeOrchestrationClose, orchestrationStore } from "./storage"
import { OrchestrationError } from "./store"

interface TaskHost {
  state(id: string): Promise<{ outcome: string }>
  result(id: string): Promise<unknown>
  send(id: string, message: string, options: { commandId: string }): Promise<{ receipt?: CommandReceipt }>
  stop(id: string): Promise<boolean>
}
export interface TaskAuthority { authorize(sessionId: string): Promise<boolean>; host(sessionId: string): Promise<TaskHost> }
const authorities = new Map<string, TaskAuthority>()
let timer: ReturnType<typeof setInterval> | undefined
let ticking = false
let generation = 0
export function closeTaskMonitor(): void { generation++; clearInterval(timer); timer = undefined; authorities.clear() }
export function attachTaskAuthority(scope: string, parentSessionId: string, authority: TaskAuthority): void {
  authorities.set(JSON.stringify([scope, parentSessionId]), authority)
  if (!timer) { timer = setInterval(() => { void refreshDelegatedTasks() }, 1000); timer.unref(); beforeOrchestrationClose(closeTaskMonitor) }
  void refreshDelegatedTasks()
}
export async function refreshDelegatedTasks(): Promise<void> {
  if (ticking) return
  ticking = true
  const current = generation
  try {
    for (const [key, authority] of authorities) {
      const [scope, parentSessionId] = JSON.parse(key) as [string, string]
      const tasks = orchestrationStore().tasks(scope, parentSessionId)
      for (const task of tasks) {
        if (task.acknowledgedAt || task.state === "cancelled" || !await authority.authorize(task.parentSessionId) || !await authority.authorize(task.childSessionId)) continue
        try {
          let updated = task
          if (task.state === "running") {
            const host = await authority.host(task.childSessionId)
            const state = await host.state(task.childSessionId)
            if (!["completed", "error"].includes(state.outcome)) continue
            const result = await host.result(task.childSessionId)
            if (generation !== current) return
            if (!await authority.authorize(task.parentSessionId) || !await authority.authorize(task.childSessionId)) continue
            if (generation !== current) return
            if (!orchestrationStore().tasks(scope, parentSessionId).some((value) => value.id === task.id && value.state === "running" && !value.acknowledgedAt)) continue
            updated = orchestrationStore().updateTask(scope, task.id, { state: state.outcome === "completed" ? "completed" : "error", result }, "running")
          }
          const persisted = orchestrationStore().tasks(scope, parentSessionId).find((value) => value.id === task.id)
          if (!persisted) continue
          updated = persisted
          const blocking = updated.deliveryDisposition === "blocking" && (updated.blockingDeadline ?? 0) > Date.now()
          if (!blocking && !updated.acknowledgedAt && updated.state !== "cancelled" && !updated.wakeupCommandId) {
            const commandId = `task-result-${task.id}`
            const host = await authority.host(task.parentSessionId)
            if (!await authority.authorize(task.parentSessionId) || !await authority.authorize(task.childSessionId)) continue
            if (generation !== current) return
            const currentTask = orchestrationStore().tasks(scope, parentSessionId).find((value) => value.id === task.id)
            if (!currentTask) continue
            updated = currentTask
            if (updated.acknowledgedAt || updated.state === "cancelled" || updated.wakeupCommandId || (updated.deliveryDisposition === "blocking" && (updated.blockingDeadline ?? 0) > Date.now())) continue
            const delivered = await host.send(task.parentSessionId, formatTaskWakeup(updated), { commandId })
            if (generation !== current) return
            if (delivered.receipt) orchestrationStore().updateTask(scope, task.id, { wakeupCommandId: commandId })
          }
        } catch { /* Keep the durable result for a later authorized refresh. */ }
      }
    }
  } finally { ticking = false }
}
export function acknowledgeTask(scope: string, parentSessionId: string, id: string): DelegatedTask {
  const task = orchestrationStore().tasks(scope, parentSessionId).find((value) => value.id === id)
  if (!task) throw new OrchestrationError(404, "Delegated task not found")
  if (task.state === "running") throw new OrchestrationError(409, "The task has not completed")
  return task.acknowledgedAt ? task : orchestrationStore().updateTask(scope, id, { acknowledgedAt: Date.now() })
}
export async function cancelTask(scope: string, parentSessionId: string, id: string, authority: TaskAuthority): Promise<DelegatedTask> {
  const task = orchestrationStore().tasks(scope, parentSessionId).find((value) => value.id === id)
  if (!task || !await authority.authorize(task.childSessionId)) throw new OrchestrationError(404, "Delegated task not found")
  if (task.state !== "running") return task
  const host = await authority.host(task.childSessionId)
  if (!await authority.authorize(parentSessionId) || !await authority.authorize(task.childSessionId)) throw new OrchestrationError(403, "Session access changed before cancellation")
  const current = orchestrationStore().tasks(scope, parentSessionId).find((value) => value.id === id)
  if (!current || current.state !== "running") return current ?? task
  await host.stop(task.childSessionId)
  return orchestrationStore().updateTask(scope, id, { state: "cancelled" }, "running")
}
