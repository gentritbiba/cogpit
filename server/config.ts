import { readFile, writeFile, stat, readdir } from "node:fs/promises"
import { join, resolve } from "node:path"
import { homedir } from "node:os"
import { fileURLToPath } from "node:url"
import { hashPassword, isPasswordHashed } from "./password-utils"

const __dirname = fileURLToPath(new URL(".", import.meta.url))
const PROJECT_ROOT = resolve(__dirname, "..")

let CONFIG_PATH = join(PROJECT_ROOT, "config.local.json")

/**
 * Override the config file path at runtime (used by Electron main process
 * to store config in userData instead of the app bundle directory).
 */
export function setConfigPath(p: string): void {
  CONFIG_PATH = p
}

export interface AppConfig {
  claudeDir: string
  /**
   * True when Cogpit bootstrapped from an existing Codex installation and the
   * Claude history directory is only a compatibility path. This keeps the
   * existing directory contract intact without requiring Claude Code.
   */
  codexOnly?: boolean
  networkAccess?: boolean
  networkPassword?: string
  terminalApp?: string
  editorApp?: string
}

let cachedConfig: AppConfig | null = null

export function getConfig(): AppConfig | null {
  return cachedConfig
}

async function detectCodexOnlyConfig(): Promise<AppConfig | null> {
  const codexHome = resolve(process.env.CODEX_HOME || join(homedir(), ".codex"))
  try {
    const codexStat = await stat(codexHome)
    if (codexStat.isDirectory()) {
      return {
        claudeDir: join(homedir(), ".claude"),
        codexOnly: true,
      }
    }
  } catch {
    // Codex is not installed/configured either — show normal setup.
  }
  return null
}

export async function loadConfig(): Promise<AppConfig | null> {
  let raw: string
  try {
    raw = await readFile(CONFIG_PATH, "utf-8")
  } catch (error) {
    // A first-run Codex user should not be forced to create a Claude history
    // directory. Only bootstrap on a genuinely missing config file: malformed
    // or unreadable user configuration must remain visible instead of being
    // silently ignored.
    cachedConfig = (error as NodeJS.ErrnoException).code === "ENOENT"
      ? await detectCodexOnlyConfig()
      : null
    return cachedConfig
  }

  try {
    const parsed = JSON.parse(raw)
    if (parsed.claudeDir && typeof parsed.claudeDir === "string") {
      let networkPassword: string | undefined = parsed.networkPassword || undefined

      // Migrate plaintext password to hashed form on first read.
      // Empty/missing passwords are left as-is; already-hashed values are skipped.
      if (networkPassword && !isPasswordHashed(networkPassword)) {
        networkPassword = hashPassword(networkPassword)
        // Write the hashed password back to disk so migration only happens once.
        const migrated = { ...parsed, networkPassword }
        await writeFile(CONFIG_PATH, JSON.stringify(migrated, null, 2), "utf-8")
      }

      cachedConfig = {
        claudeDir: parsed.claudeDir,
        codexOnly: !!parsed.codexOnly,
        networkAccess: !!parsed.networkAccess,
        networkPassword,
        terminalApp: parsed.terminalApp || undefined,
        editorApp: parsed.editorApp || undefined,
      }
      return cachedConfig
    }
  } catch {
    // File is malformed or a migration failed.
  }
  cachedConfig = null
  return null
}

export async function saveConfig(config: AppConfig): Promise<void> {
  await writeFile(CONFIG_PATH, JSON.stringify(config, null, 2), "utf-8")
  cachedConfig = config
}

interface ValidationResult {
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
