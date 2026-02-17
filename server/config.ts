import { readFile, writeFile, stat, readdir } from "node:fs/promises"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = fileURLToPath(new URL(".", import.meta.url))
const PROJECT_ROOT = resolve(__dirname, "..")

export const CONFIG_PATH = join(PROJECT_ROOT, "config.local.json")

export interface AppConfig {
  claudeDir: string
}

let cachedConfig: AppConfig | null = null

export function getConfig(): AppConfig | null {
  return cachedConfig
}

export async function loadConfig(): Promise<AppConfig | null> {
  try {
    const raw = await readFile(CONFIG_PATH, "utf-8")
    const parsed = JSON.parse(raw)
    if (parsed.claudeDir && typeof parsed.claudeDir === "string") {
      cachedConfig = { claudeDir: parsed.claudeDir }
      return cachedConfig
    }
  } catch {
    // File doesn't exist or is malformed
  }
  cachedConfig = null
  return null
}

export async function saveConfig(config: AppConfig): Promise<void> {
  await writeFile(CONFIG_PATH, JSON.stringify(config, null, 2), "utf-8")
  cachedConfig = config
}

export interface ValidationResult {
  valid: boolean
  error?: string
  resolved?: string
}

export async function validateClaudeDir(dirPath: string): Promise<ValidationResult> {
  const resolved = resolve(dirPath)

  try {
    const s = await stat(resolved)
    if (!s.isDirectory()) {
      return { valid: false, error: "Path is not a directory" }
    }
  } catch {
    return { valid: false, error: "Path does not exist" }
  }

  try {
    const entries = await readdir(resolved)
    if (!entries.includes("projects")) {
      return {
        valid: false,
        error: 'Directory does not contain a "projects" subdirectory. This does not appear to be a valid .claude directory.',
      }
    }
  } catch {
    return { valid: false, error: "Cannot read directory contents" }
  }

  return { valid: true, resolved }
}

export function getDirs(claudeDir: string) {
  return {
    PROJECTS_DIR: join(claudeDir, "projects"),
    TEAMS_DIR: join(claudeDir, "teams"),
    TASKS_DIR: join(claudeDir, "tasks"),
    UNDO_DIR: join(PROJECT_ROOT, "undo-history"),
  }
}
