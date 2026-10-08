import { readFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join, relative, sep } from "node:path"
import type { WorkspaceEnvironment, WorkspaceRunContext } from "../../shared/contracts/workspaces"
import { validEnvironmentPath } from "./environment"
import { REPO_KEY_RE } from "./snapshot"

export function workspacesRoot(): string {
  return process.env.COGPIT_WORKSPACES_DIR || join(homedir(), ".cogpit", "workspaces")
}

export function workspaceRecordPath(repoKey: string, task: string): string {
  return join(workspacesRoot(), repoKey, `.${task}.workspace.json`)
}

export function environmentFrom(value: unknown): WorkspaceEnvironment | undefined {
  const env = value as Partial<WorkspaceEnvironment> | null
  if (!env || !["target-checkout", "caller", "none"].includes(env.source ?? "")
    || !Array.isArray(env.files) || env.files.length > 100
    || !env.files.every((name) => typeof name === "string" && validEnvironmentPath(name))) return undefined
  return { source: env.source!, files: env.files,
    ...(typeof env.checkout === "string" ? { checkout: env.checkout } : {}),
    ...(typeof env.note === "string" ? { note: env.note } : {}) }
}

export function runContextFrom(value: unknown): WorkspaceRunContext | undefined {
  const run = value as Partial<WorkspaceRunContext> | null
  if (!run || !Number.isInteger(run.port) || run.port! < 1 || run.port! > 65535
    || typeof run.composeProjectName !== "string" || !/^cogpit-[a-f0-9]{16}$/.test(run.composeProjectName)) return undefined
  return { port: run.port!, composeProjectName: run.composeProjectName }
}

/** Device-local status reads only names and run hints from the import record. */
export async function workspaceDetailsForCwd(cwd: string): Promise<{ environment?: WorkspaceEnvironment; run?: WorkspaceRunContext }> {
  const [repoKey, task] = relative(workspacesRoot(), cwd).split(sep)
  if (!repoKey || !REPO_KEY_RE.test(repoKey) || !task || !/^[a-zA-Z0-9_][a-zA-Z0-9._-]{0,63}$/.test(task) || task.includes("..")) return {}
  try {
    const record = JSON.parse(await readFile(workspaceRecordPath(repoKey, task), "utf8")) as { environment?: unknown; run?: unknown }
    const environment = environmentFrom(record.environment)
    const run = runContextFrom(record.run)
    return { ...(environment ? { environment } : {}), ...(run ? { run } : {}) }
  } catch { return {} }
}
