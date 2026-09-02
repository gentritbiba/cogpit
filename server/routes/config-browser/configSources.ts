/**
 * Where each agent CLI keeps its instructions, settings, skills, agents and
 * commands — assembled from the descriptor table rather than hand-listed, so an
 * agent Cogpit can drive is an agent the user can configure.
 *
 * Global roots come from the configured home directories, not from `homedir()`:
 * a `$CODEX_HOME` or a non-default Claude directory used to leave the browser
 * showing an empty tree while the CLI read somewhere else entirely.
 */
import { realpath } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import {
  allDescriptors,
  descriptorForDirName,
  type AgentConfigFile,
  type AgentConfigLayout,
  type AgentConfigScope,
  type AgentDescriptor,
} from "../../../shared/session/agent-descriptors"
import { agentHomeDir } from "../../config"
import {
  CLI_ORDER,
  SHARED_CONFIG_DIR_NAME,
  type CliSourceDir,
  type CliSourceFile,
  type ConfigCli,
  type ConfigScopeLayout,
  type ConfigTreeItem,
} from "./configTypes"

/**
 * The directory a CLI reads config from at one scope. Globally that is the
 * configured home; in a project it is a fixed directory name at the root.
 */
function configRoot(
  descriptor: AgentDescriptor,
  scope: AgentConfigScope,
  scopeRoot: string,
): string {
  return scope === "global"
    ? agentHomeDir(descriptor.kind)
    : join(scopeRoot, descriptor.config.rootDirName)
}

/** Display order: the agent owning unprefixed projects first, then the rest. */
function orderedDescriptors(): AgentDescriptor[] {
  const byKind = new Map(allDescriptors().map((descriptor) => [descriptor.kind, descriptor]))
  return CLI_ORDER.flatMap((kind) => {
    const descriptor = byKind.get(kind)
    return descriptor ? [descriptor] : []
  })
}

function filesFor(
  pick: (layout: AgentConfigLayout) => readonly AgentConfigFile[],
  scope: AgentConfigScope,
  scopeRoot: string,
): CliSourceFile[] {
  return orderedDescriptors().flatMap((descriptor) =>
    pick(descriptor.config)
      .filter((file) => file.scopes.includes(scope))
      .map((file) => ({
        path: join(
          file.in === "scope" ? scopeRoot : configRoot(descriptor, scope, scopeRoot),
          file.path,
        ),
        name: file.label ?? file.path,
        cli: [descriptor.kind as ConfigCli],
      })),
  )
}

function dirsFor(
  pick: (layout: AgentConfigLayout) => string | null,
  scope: AgentConfigScope,
  scopeRoot: string,
): CliSourceDir[] {
  return orderedDescriptors().flatMap((descriptor) => {
    const name = pick(descriptor.config)
    return name
      ? [{ dir: join(configRoot(descriptor, scope, scopeRoot), name), cli: [descriptor.kind] }]
      : []
  })
}

/** Directories only the global scope has, such as themes and plugin installs. */
function globalOnlyDirs(
  pick: (layout: AgentConfigLayout) => string | null,
  scope: AgentConfigScope,
  scopeRoot: string,
): CliSourceDir[] {
  return scope === "global" ? dirsFor(pick, scope, scopeRoot) : []
}

function buildLayout(scope: AgentConfigScope, scopeRoot: string): ConfigScopeLayout {
  const sharedRoot = join(scopeRoot, SHARED_CONFIG_DIR_NAME)

  return {
    // New files land with the agent that owns every unprefixed project — the
    // one an install has by definition, whichever others are also present.
    baseDir: configRoot(descriptorForDirName(null), scope, scopeRoot),
    instructions: filesFor((layout) => layout.instructions, scope, scopeRoot),
    settings: filesFor((layout) => layout.settings, scope, scopeRoot),
    skills: [
      ...dirsFor((layout) => layout.skillsDir, scope, scopeRoot),
      // Loaded by no CLI directly; it is what the others link into.
      { dir: join(sharedRoot, "skills"), cli: [] },
    ],
    agents: dirsFor((layout) => layout.agentsDir, scope, scopeRoot),
    commands: dirsFor((layout) => layout.commandsDir, scope, scopeRoot),
    themes: globalOnlyDirs((layout) => layout.themesDir, scope, scopeRoot),
    plugins: globalOnlyDirs((layout) => layout.pluginsDir, scope, scopeRoot),
  }
}

/** Global scope: each CLI's configured home, plus the shared `.agents` tree. */
export function globalLayout(): ConfigScopeLayout {
  return buildLayout("global", homedir())
}

/** Project scope: `<cwd>/.claude`, `<cwd>/.codex`, `<cwd>/.copilot`, `<cwd>/.agents`. */
export function projectLayout(cwd: string): ConfigScopeLayout {
  return buildLayout("project", cwd)
}

// ── Merging ────────────────────────────────────────────────────────────

function unionCli(a: ConfigCli[] | undefined, b: ConfigCli[] | undefined): ConfigCli[] {
  const merged = new Set([...(a ?? []), ...(b ?? [])])
  return CLI_ORDER.filter((cli) => merged.has(cli))
}

async function canonicalKey(path: string): Promise<string> {
  return realpath(path).catch(() => path)
}

/**
 * Collapse entries from several CLI directories that resolve to the same file.
 * Earlier groups win the representative entry, so pass the directories in
 * display-preference order.
 */
export async function mergeCliItems(groups: ConfigTreeItem[][]): Promise<ConfigTreeItem[]> {
  // Insertion-ordered, so the first group's entries stay first.
  const byKey = new Map<string, ConfigTreeItem>()
  /** Directories that took in children from a second group, and only those. */
  const combined = new Set<ConfigTreeItem>()

  for (const group of groups) {
    const keys = await Promise.all(group.map((item) => canonicalKey(item.path)))
    group.forEach((item, index) => {
      const key = keys[index]
      const existing = byKey.get(key)
      if (!existing) {
        byKey.set(key, { ...item, cli: item.cli ?? [] })
        return
      }
      existing.cli = unionCli(existing.cli, item.cli)
      if (!existing.description) existing.description = item.description
      if (existing.children && item.children) {
        existing.children = [...existing.children, ...item.children]
        combined.add(existing)
      }
    })
  }

  const merged = [...byKey.values()]

  // Only a directory fed by several roots can hold duplicate children; the rest
  // came from a single scan and are already distinct.
  for (const item of combined) {
    if (item.children) item.children = await mergeCliItems([item.children])
  }

  return merged
}
