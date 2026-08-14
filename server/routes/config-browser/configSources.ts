import { realpath } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import type { ConfigCli, ConfigScopeLayout, ConfigTreeItem } from "./configTypes"

const CLI_ORDER: ConfigCli[] = ["claude", "codex"]

type ScopeDirs = Pick<ConfigScopeLayout, "skills" | "agents" | "commands">

/** The directories both scopes lay out the same way, given their CLI roots. */
function scopeDirs(claude: string, codex: string, shared: string): ScopeDirs {
  return {
    skills: [
      { dir: join(claude, "skills"), cli: ["claude"] },
      { dir: join(codex, "skills"), cli: ["codex"] },
      { dir: join(shared, "skills"), cli: [] },
    ],
    agents: [
      { dir: join(claude, "agents"), cli: ["claude"] },
      { dir: join(codex, "agents"), cli: ["codex"] },
    ],
    commands: [
      { dir: join(claude, "commands"), cli: ["claude"] },
      { dir: join(codex, "prompts"), cli: ["codex"] },
    ],
  }
}

/** Global scope: ~/.claude, ~/.codex, and the shared ~/.agents source of truth. */
export function globalLayout(): ConfigScopeLayout {
  const home = homedir()
  const claude = join(home, ".claude")
  const codex = join(home, ".codex")

  return {
    baseDir: claude,
    instructions: [
      { path: join(claude, "CLAUDE.md"), name: "CLAUDE.md", cli: ["claude"] },
      { path: join(home, "AGENTS.md"), name: "AGENTS.md", cli: ["codex"] },
    ],
    settings: [
      { path: join(claude, "settings.json"), name: "settings.json", cli: ["claude"] },
      { path: join(codex, "config.toml"), name: "config.toml", cli: ["codex"] },
    ],
    ...scopeDirs(claude, codex, join(home, ".agents")),
    themesDir: join(claude, "themes"),
  }
}

/** Project scope: <cwd>/.claude, <cwd>/.codex, <cwd>/.agents. */
export function projectLayout(cwd: string): ConfigScopeLayout {
  const claude = join(cwd, ".claude")
  const codex = join(cwd, ".codex")

  return {
    baseDir: claude,
    instructions: [
      { path: join(cwd, "CLAUDE.md"), name: "CLAUDE.md", cli: ["claude"] },
      { path: join(claude, "CLAUDE.md"), name: ".claude/CLAUDE.md", cli: ["claude"] },
      { path: join(cwd, "AGENTS.md"), name: "AGENTS.md", cli: ["codex"] },
    ],
    settings: [
      { path: join(claude, "settings.local.json"), name: "settings.local.json", cli: ["claude"] },
      { path: join(codex, "config.toml"), name: "config.toml", cli: ["codex"] },
    ],
    ...scopeDirs(claude, codex, join(cwd, ".agents")),
  }
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
