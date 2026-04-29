import { readdir, readFile } from "node:fs/promises"
import { join, relative } from "node:path"

// ── Types ────────────────────────────────────────────────────────────────────

export interface ScriptEntry {
  name: string
  command: string
  dir: string
  dirLabel: string
  isCommon: boolean
}

// ── Constants ────────────────────────────────────────────────────────────────

const COMMON_SCRIPTS = new Set([
  "dev", "start", "build", "test", "serve", "watch", "preview", "lint", "typecheck",
])

const SKIP_DIRS = new Set([
  "node_modules", ".git", "dist", "build", ".next", ".nuxt", ".output",
])

// ── Discovery ────────────────────────────────────────────────────────────────

async function extractScripts(
  dir: string,
  dirLabel: string,
): Promise<ScriptEntry[]> {
  try {
    const raw = await readFile(join(dir, "package.json"), "utf-8")
    const pkg = JSON.parse(raw)
    const scripts = pkg.scripts
    if (!scripts || typeof scripts !== "object") return []

    return Object.entries(scripts).map(([name, command]) => ({
      name,
      command: String(command),
      dir,
      dirLabel,
      isCommon: COMMON_SCRIPTS.has(name),
    }))
  } catch {
    return []
  }
}

export async function discoverScripts(projectDir: string): Promise<ScriptEntry[]> {
  const results: ScriptEntry[] = []

  // 1. Root package.json
  const rootScripts = await extractScripts(projectDir, "root/")
  results.push(...rootScripts)

  // 2. Immediate child directories
  try {
    const entries = await readdir(projectDir, { withFileTypes: true })
    const childDirs = entries.filter(
      (e) => e.isDirectory() && !e.name.startsWith(".") && !SKIP_DIRS.has(e.name)
    )

    const childResults = await Promise.all(
      childDirs.map(async (entry) => {
        const childPath = join(projectDir, entry.name)
        const label = relative(projectDir, childPath) + "/"
        return extractScripts(childPath, label)
      })
    )

    for (const scripts of childResults) {
      results.push(...scripts)
    }
  } catch {
    // can't read directory, skip children
  }

  // Sort: root first, then child dirs alphabetically
  // Within each group: common scripts first, then alphabetical
  results.sort((a, b) => {
    if (a.dirLabel === "root/" && b.dirLabel !== "root/") return -1
    if (a.dirLabel !== "root/" && b.dirLabel === "root/") return 1
    if (a.dirLabel !== b.dirLabel) return a.dirLabel.localeCompare(b.dirLabel)
    if (a.isCommon && !b.isCommon) return -1
    if (!a.isCommon && b.isCommon) return 1
    return a.name.localeCompare(b.name)
  })

  return results
}
