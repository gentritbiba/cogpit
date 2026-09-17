import { realpath } from "node:fs/promises"
import { isAbsolute, relative, sep } from "node:path"
import type { PluginProject } from "./projects"
import type { LegacyClickUpImport } from "./connectionStore"
import type { ConnectionDefinition } from "@cogpit/plugin-contracts"
import { createConnectionExecutor, type ConnectionTransport, type HostConnection, type ConnectionResult } from "./connectionExecutor"
import { PluginDataError, type DataGuard } from "./privateStore"

const result = <T>(value: ConnectionResult<T>): T => { if (value.ok) return value.data; throw new PluginDataError(value.error, "Legacy connection validation failed") }
export function withinProject(path: string, project: PluginProject): boolean { return project.paths.some(root => { const part = relative(root, path); return part === "" || part !== ".." && !part.startsWith(`..${sep}`) && !isAbsolute(part) }) }
export function projectForPath(path: string, projects: readonly PluginProject[]): PluginProject | null {
  const matches = projects.flatMap(project => project.paths.filter(root => withinProject(path, { ...project, paths: [root] })).map(root => ({ project, length: root.length }))).sort((a, b) => b.length - a.length)
  if (!matches[0] || matches.some(match => match.length === matches[0].length && match.project.id !== matches[0].project.id)) return null
  return matches[0].project
}
export async function legacyProjectLink(source: LegacyClickUpImport, project: PluginProject | null, projects: readonly PluginProject[]): Promise<{ path: string; list: string } | null> {
  if (!project || source.decidedProjects.includes(project.id)) return null
  for (const [path, list] of Object.entries(source.projects)) {
    if (source.importedProjects.includes(path)) continue
    try { if (projectForPath(await realpath(path), projects)?.id === project.id) return { path, list } } catch { /* Unopened or unavailable projects remain pending. */ }
  }
  return null
}
export async function validateLegacyClickUp(input: { definition: ConnectionDefinition; connection: HostConnection; listId?: string; resetUnavailableWorkspace?: boolean; transport: ConnectionTransport; operations: readonly string[]; signal: AbortSignal; guard: DataGuard }): Promise<HostConnection> {
  const connection = structuredClone(input.connection)
  const executor = () => createConnectionExecutor(input.definition, connection, { transport: input.transport, allowedOperations: input.operations, signal: input.signal })
  const checked = async <T>(operation: Promise<ConnectionResult<T>>) => { const value = result(await operation); await input.guard(); return value }
  connection.identity = (await checked(executor().validate())).identity
  const workspaces = await checked(executor().listOptions("workspace"))
  if (input.resetUnavailableWorkspace && connection.selected.workspace && !workspaces.some(workspace => workspace.id === connection.selected.workspace.id)) connection.selected = {}
  const selectedWorkspace = connection.selected.workspace
  const candidates = selectedWorkspace ? workspaces.filter(item => item.id === selectedWorkspace.id) : workspaces
  let parent: string | undefined
  if (input.listId) parent = (await checked(executor().resolveResourceInput("list", input.listId))).parents.space
  for (const workspace of candidates) {
    connection.selected = await checked(executor().selectResource("workspace", workspace.id))
    if (!input.listId) return connection
    const spaces = await checked(executor().listOptions("space"))
    const space = spaces.find(item => item.id === parent)
    if (!space) continue
    connection.selected = await checked(executor().selectResource("space", space.id))
    connection.selected = await checked(executor().selectResource("list", input.listId))
    return connection
  }
  throw new PluginDataError("RESOURCE_REQUIRED", "Select a compatible ClickUp workspace before importing the project link")
}
