import type { PluginProjectSummary } from "../../shared/contracts/pluginManagement"

export function resolveRuntimeProject(projects: readonly PluginProjectSummary[], projectPath: string | null, platform: string): PluginProjectSummary | null {
  if (!projectPath) return null
  const normalize = (path: string) => {
    const value = (platform === "win32" ? path.replaceAll("\\", "/").toLowerCase() : path).replace(/\/+$/, "") || "/"
    return value.split("/").some((part) => part === "." || part === "..") ? null : value
  }
  const current = normalize(projectPath)
  if (!current) return null
  let match: PluginProjectSummary | null = null, longest = -1
  for (const project of projects) {
    for (const path of project.paths) {
      const root = normalize(path)
      if (root && root.length > longest && (current === root || current.startsWith(root.endsWith("/") ? root : `${root}/`))) {
        match = project
        longest = root.length
      }
    }
  }
  return match
}
