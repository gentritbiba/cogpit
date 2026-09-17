import type { RegisteredWorkspacePanel } from "@/plugin-api"

const aliases: Readonly<Record<string, string>> = {
  "github.repository": "cogpit.github.repository",
  "clickup.tasks": "cogpit.clickup.tasks",
  "vercel-deployments.deployments": "cogpit.vercel.deployments",
}

export function canonicalPluginPanelId(id: string | null): string | null {
  return id === null ? null : aliases[id] ?? id
}

export function resolvePluginPanelPreference(id: string | null, panels: readonly RegisteredWorkspacePanel[]): RegisteredWorkspacePanel | null {
  if (!id) return null
  return panels.find((panel) => panel.id === id) ?? panels.find((panel) => panel.id === aliases[id]) ?? null
}
