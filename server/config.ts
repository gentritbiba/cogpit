import { readFile, stat, readdir, chmod } from "node:fs/promises"
import { join, resolve } from "node:path"
import { homedir } from "node:os"
import { fileURLToPath } from "node:url"
import { hashPassword, isMalformedPasswordHash, isPasswordHashed } from "./password-utils"
import { writeOwnerOnlyJson } from "./atomicJsonFile"

// config.local.json may hold a hashed network password; keep it owner-only.
const CONFIG_FILE_MODE = 0o600

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

/**
 * In-memory only network credentials derived from the environment
 * (COGPIT_NETWORK_PASSWORD / COGPIT_NETWORK_PASSWORD_FILE) on a headless box.
 *
 * These are merged into the value returned by getConfig() so auth works, but
 * are NEVER part of cachedConfig and are stripped by saveConfig so they can
 * never leak to disk (systemd LoadCredential / secret-manager friendly).
 */
interface EnvNetworkOverride {
  /** Already hashed with hashPassword(). */
  networkPassword: string
}

let envOverride: EnvNetworkOverride | null = null

/**
 * Apply an in-memory network password sourced from the environment. Hashes the
 * plaintext once and keeps only the hash. Enabling network access this way is
 * intentionally ephemeral: it lives in process memory and never touches disk.
 */
export function applyEnvNetworkOverrides(opts: { password: string }): void {
  envOverride = { networkPassword: hashPassword(opts.password) }
}

/** Clear the in-memory env override (primarily for tests). */
export function clearEnvNetworkOverrides(): void {
  envOverride = null
}

export function getConfig(): AppConfig | null {
  if (!cachedConfig || !envOverride) return cachedConfig
  // Merge the env override into the returned view only. cachedConfig itself is
  // never mutated, so nothing here can be round-tripped back to disk.
  return {
    ...cachedConfig,
    networkAccess: true,
    networkPassword: envOverride.networkPassword,
  }
}

/**
 * Remove any credentials that originated from the in-memory env override before
 * persisting. A user-set password is freshly hashed (different salt) and never
 * matches the override, so genuine user changes are preserved.
 */
function stripEnvOverride(config: AppConfig): AppConfig {
  if (!envOverride) return config
  if (!config.networkPassword || config.networkPassword === envOverride.networkPassword) {
    const clean: AppConfig = {
      ...config,
      networkAccess: cachedConfig?.networkAccess,
      networkPassword: cachedConfig?.networkPassword,
    }
    if (!clean.networkPassword) delete clean.networkPassword
    return clean
  }
  return config
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

      // A corrupt or future versioned credential is not plaintext. Preserve the
      // file and fail closed so loading cannot re-hash the encoded bytes and
      // silently make the real password unrecoverable.
      if (networkPassword && isMalformedPasswordHash(networkPassword)) {
        throw new Error("Unsupported or malformed network password hash")
      }

      // Migrate plaintext password to hashed form on first read.
      // Empty/missing passwords are left as-is; already-hashed values are skipped.
      if (networkPassword && !isPasswordHashed(networkPassword)) {
        networkPassword = hashPassword(networkPassword)
        // Write the hashed password back to disk so migration only happens once.
        const migrated = { ...parsed, networkPassword }
        await writeOwnerOnlyJson(CONFIG_PATH, migrated, CONFIG_FILE_MODE)
      }

      // Existing installations may predate the owner-only creation mode used
      // by saveConfig(). Re-apply it on every successful read so an old file
      // containing a password cannot remain group/world-readable indefinitely.
      await chmod(CONFIG_PATH, CONFIG_FILE_MODE)

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
  const toPersist = stripEnvOverride(config)
  await writeOwnerOnlyJson(CONFIG_PATH, toPersist, CONFIG_FILE_MODE)
  cachedConfig = toPersist
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
