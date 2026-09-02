import { readFile, stat, readdir, chmod } from "node:fs/promises"
import { join, resolve } from "node:path"
import { homedir } from "node:os"
import { fileURLToPath } from "node:url"
import {
  AGENT_KINDS,
  allDescriptors,
  descriptorFor,
  soleDescriptorWhere,
  type AgentKind,
} from "../shared/session/agent-descriptors"
import { hashPassword, isMalformedPasswordHash, isPasswordHashed } from "./password-utils"
import { writeOwnerOnlyJson } from "./atomicJsonFile"
import { findExecutableOnPath } from "./lib/binaryResolver"

// config.local.json may hold a hashed network password; keep it owner-only.
const CONFIG_FILE_MODE = 0o600

const __dirname = fileURLToPath(new URL(".", import.meta.url))
const PROJECT_ROOT = resolve(__dirname, "..")

/**
 * Where Cogpit stores the data it owns (undo history, per-session config).
 * Defaults to the project root for dev and tests; packaged builds point it at
 * the OS user-data directory because the app bundle is read-only.
 */
let DATA_ROOT = PROJECT_ROOT

let CONFIG_PATH = join(PROJECT_ROOT, "config.local.json")

/**
 * Override the writable data root at runtime (Electron and standalone entry
 * points). Must be called before refreshDirs() so the directories it derives
 * stay writable across later config reloads.
 */
export function setDataRoot(dir: string): void {
  DATA_ROOT = dir
}

export function getDataRoot(): string {
  return DATA_ROOT
}

/**
 * Override the config file path at runtime (used by Electron main process
 * to store config in userData instead of the app bundle directory).
 */
export function setConfigPath(p: string): void {
  CONFIG_PATH = p
}

/**
 * The one agent whose home Cogpit has to be told about. Every other CLI keeps
 * its own at a fixed, environment-overridable location {@link agentHomeDir}
 * discovers; this one's is a user-chosen path stored in Cogpit's own config.
 */
const CONFIGURED_HOME_AGENT = soleDescriptorWhere(
  (descriptor) => !descriptor.cli.homeIsDiscoverable,
  "a home Cogpit has to be told about",
)

export interface AppConfig {
  /**
   * Claude Code's home directory: the one agent home Cogpit stores itself,
   * the rest being discovered. The field keeps its historical name on disk
   * and on the wire.
   */
  claudeDir: string
  /** Agent new sessions default to. */
  defaultAgent?: AgentKind
  /**
   * Whether `claudeDir` was invented while bootstrapping an install that has no
   * Claude Code, and so has never been proven to be a real Claude home. Saving
   * settings may reuse that exact path; any other path must still validate.
   */
  claudeDirIsPlaceholder?: boolean
  /** Team-edition opt-in; only the standalone shell honors it. */
  edition?: "team"
  networkAccess?: boolean
  networkPassword?: string
  terminalApp?: string
  editorApp?: string
  /** Route "open in editor" affordances to Cogpit's own file workspace. */
  useBuiltInEditor?: boolean
}

let cachedConfig: AppConfig | null = null
let configuredEditionValue: string | undefined

/** Raw persisted edition value for resolution diagnostics before sanitization. */
export function getConfiguredEditionValue(): string | undefined {
  return configuredEditionValue
}

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

/**
 * Absolute home directory of one agent CLI.
 *
 * The configured agent's is whatever the user chose; the rest live at a fixed
 * name under the user's home unless their own environment variable moves them.
 * Read live rather than captured at import, because the config browser has to
 * follow a `claudeDir` change without a restart.
 */
export function agentHomeDir(kind: AgentKind): string {
  const { cli } = descriptorFor(kind)
  const fallback = join(homedir(), cli.homeDirName)
  if (!cli.homeIsDiscoverable) return resolve(cachedConfig?.claudeDir || fallback)
  const override = cli.homeEnvVar ? process.env[cli.homeEnvVar] : undefined
  return resolve(override || fallback)
}

/**
 * Bootstrap configuration for a machine that has a discoverable agent CLI but
 * not the configured one. `claudeDir` is a placeholder so the rest of the app
 * has a history root to name; nothing is ever read from it until the user
 * points it somewhere real.
 *
 * Evidence is either the CLI's own state directory or its binary on PATH — the
 * second case covers a CLI that has been installed but never run.
 */
async function detectBootstrapConfig(): Promise<AppConfig | null> {
  const discoverable = allDescriptors().filter((descriptor) => descriptor.cli.homeIsDiscoverable)
  const placeholder = () => join(homedir(), CONFIGURED_HOME_AGENT.cli.homeDirName)

  for (const descriptor of discoverable) {
    const marker = join(agentHomeDir(descriptor.kind), descriptor.cli.installMarker)
    try {
      if ((await stat(marker)).isDirectory()) {
        return { claudeDir: placeholder(), defaultAgent: descriptor.kind, claudeDirIsPlaceholder: true }
      }
    } catch {
      // Try the next agent.
    }
  }
  for (const descriptor of discoverable) {
    if (findExecutableOnPath(descriptor.binName)) {
      return { claudeDir: placeholder(), defaultAgent: descriptor.kind, claudeDirIsPlaceholder: true }
    }
  }
  return null
}

/** Narrow an arbitrary persisted value to an agent kind. */
function parseAgentKind(value: unknown): AgentKind | undefined {
  return AGENT_KINDS.find((kind) => kind === value)
}

export async function loadConfig(): Promise<AppConfig | null> {
  configuredEditionValue = undefined
  let raw: string
  try {
    raw = await readFile(CONFIG_PATH, "utf-8")
  } catch (error) {
    // A first-run external-provider user should not need a Claude history
    // directory. Only bootstrap on a genuinely missing config file: malformed
    // or unreadable user configuration must remain visible instead of being
    // silently ignored.
    cachedConfig = (error as NodeJS.ErrnoException).code === "ENOENT"
      ? await detectBootstrapConfig()
      : null
    return cachedConfig
  }

  try {
    const parsed = JSON.parse(raw)
    configuredEditionValue = typeof parsed.edition === "string" ? parsed.edition : undefined
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
      // Windows has no POSIX modes: chmod only toggles the read-only bit there,
      // and throws EPERM on an already-read-only file — which this try/catch
      // would swallow into "no config at all".
      if (process.platform !== "win32") {
        await chmod(CONFIG_PATH, CONFIG_FILE_MODE)
      }

      // `externalOnly` (and before it `codexOnly`) fused two facts into one
      // field: which agent to default to, and that `claudeDir` was never a real
      // Claude home. Older files are migrated into the two separate fields, so
      // choosing a real directory no longer silently resets the agent.
      const legacyExternalOnly = parseAgentKind(parsed.externalOnly)
        ?? (parsed.codexOnly === true ? "codex" as const : undefined)

      cachedConfig = {
        claudeDir: parsed.claudeDir,
        defaultAgent: parseAgentKind(parsed.defaultAgent) ?? legacyExternalOnly,
        claudeDirIsPlaceholder: parsed.claudeDirIsPlaceholder === true
          || legacyExternalOnly !== undefined
          || undefined,
        edition: parsed.edition === "team" ? "team" : undefined,
        networkAccess: !!parsed.networkAccess,
        networkPassword,
        terminalApp: parsed.terminalApp || undefined,
        editorApp: parsed.editorApp || undefined,
        useBuiltInEditor: !!parsed.useBuiltInEditor,
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
  configuredEditionValue = toPersist.edition
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
    const { installMarker, homeDirName } = CONFIGURED_HOME_AGENT.cli
    if (!entries.includes(installMarker)) {
      return {
        valid: false,
        error: `Directory does not contain a "${installMarker}" subdirectory. This does not appear to be a valid ${homeDirName} directory.`,
      }
    }
  } catch {
    return { valid: false, error: "Cannot read directory contents" }
  }

  return { valid: true, resolved }
}

export function getDirs(claudeDir: string) {
  return {
    PROJECTS_DIR: join(claudeDir, CONFIGURED_HOME_AGENT.cli.installMarker),
    TEAMS_DIR: join(claudeDir, "teams"),
    TASKS_DIR: join(claudeDir, "tasks"),
    UNDO_DIR: join(DATA_ROOT, "undo-history"),
    SESSION_CONFIG_DIR: join(DATA_ROOT, "session-config"),
  }
}
