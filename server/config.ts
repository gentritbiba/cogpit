import { readFile, stat, readdir, chmod } from "node:fs/promises"
import { isAbsolute, join, resolve } from "node:path"
import { homedir } from "node:os"
import { fileURLToPath } from "node:url"
import {
  AGENT_KINDS,
  PERSISTED_AGENT_HOME_FIELD,
  descriptorFor,
  installableDescriptors,
  soleDescriptorWhere,
  type AgentKind,
  type InstallableAgentDescriptor,
} from "../shared/session/agent-descriptors"
import { hashPassword, isMalformedPasswordHash, isPasswordHashed } from "./password-utils"
import { writeOwnerOnlyJson } from "./atomicJsonFile"
import { findExecutableOnPath } from "./lib/binaryResolver"
import { bundledExecutable } from "./agents/bundledExecutable"
import {
  parseExecutableChoice,
  type ExecutableChoice,
} from "../shared/contracts/agentExecutable"
import { isCogpitEdition, type CogpitEdition } from "../shared/contracts/identity"

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
  [PERSISTED_AGENT_HOME_FIELD]: string
  /** Agent new sessions default to. */
  defaultAgent?: AgentKind
  /**
   * Whether the home above is the default location, chosen while bootstrapping
   * before that directory existed. Saving settings may reuse that exact path;
   * any other path must still validate.
   */
  claudeDirIsPlaceholder?: boolean
  /** An edition package to run instead of personal edition; only the standalone shell honors it. */
  edition?: ConfiguredEdition
  networkAccess?: boolean
  networkPassword?: string
  terminalApp?: string
  editorApp?: string
  /** Route "open in editor" affordances to Cogpit's own file workspace. */
  useBuiltInEditor?: boolean
  /** Which binary the configured-home agent is spawned from; absent means auto. */
  agentExecutable?: ExecutableChoice
  /** Absolute folder the folder browser starts in; see getProjectsRoot. File-only, like `edition`. */
  projectsRoot?: string
}

/** An edition the config file may select: any but personal edition, which runs when it selects none. */
export type ConfiguredEdition = Exclude<CogpitEdition, "personal">

/** `value` when it names an edition the config file may select. */
export function configuredEdition(value: unknown): ConfiguredEdition | undefined {
  return isCogpitEdition(value) && value !== "personal" ? value : undefined
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

const warnedPaths = new Set<string>()

/** An absolute path, normalized; anything else is ignored with one warning per value. */
function absolutePathOrUndefined(value: unknown, source: string): string | undefined {
  if (value === undefined || value === null || value === "") return undefined
  if (typeof value === "string" && !value.includes("\0") && isAbsolute(value)) return resolve(value)
  const warning = `[config] Ignoring ${source}: ${JSON.stringify(value)} is not an absolute path`
  if (!warnedPaths.has(warning)) {
    warnedPaths.add(warning)
    console.warn(warning)
  }
  return undefined
}

/**
 * Where the folder browser starts: `COGPIT_PROJECTS_ROOT`, else `projectsRoot`
 * in the config file, else the home directory of the account the server runs
 * as. A server given its own HOME points this at the folders people work in.
 */
export function getProjectsRoot(): string {
  return absolutePathOrUndefined(process.env.COGPIT_PROJECTS_ROOT, "COGPIT_PROJECTS_ROOT")
    ?? cachedConfig?.projectsRoot
    ?? homedir()
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory()
  } catch {
    return false
  }
}

/**
 * How an agent CLI shows up on this machine, strongest first: its session
 * history (it has been used), its binary on PATH or its home directory
 * (installed, perhaps never used), or only the copy bundled with Cogpit.
 */
type AgentPresence = "used" | "installed" | "bundled"

async function agentPresence(descriptor: InstallableAgentDescriptor): Promise<AgentPresence | null> {
  const { cli } = descriptor
  // The configured home is not known yet, so its default location is the evidence.
  const home = cli.homeIsDiscoverable ? agentHomeDir(descriptor.kind) : join(homedir(), cli.homeDirName)
  if (await isDirectory(join(home, cli.installMarker))) return "used"
  if (findExecutableOnPath(descriptor.binName) || await isDirectory(home)) return "installed"
  return bundledExecutable(descriptor.kind) ? "bundled" : null
}

/**
 * Configuration for a machine without a config file, built from the agent CLIs
 * found on it. An agent that has been used becomes the default; otherwise the
 * order of {@link installableDescriptors} decides. A copy bundled with Cogpit
 * only counts on its own when `acceptBundled`: at startup it does not, so the
 * setup screen can first ask the person to sign in to it.
 *
 * The configured agent's home is its default location, marked a placeholder
 * until that directory exists.
 */
async function detectAgentConfig(acceptBundled: boolean): Promise<AppConfig | null> {
  const found = (await Promise.all(installableDescriptors().map(async (descriptor) => ({
    descriptor,
    presence: await agentPresence(descriptor),
  })))).filter((entry) => entry.presence !== null)
  if (!acceptBundled && found.every((entry) => entry.presence === "bundled")) return null

  const chosen = found.find((entry) => entry.presence === "used") ?? found[0]
  if (!chosen) return null
  const home = join(homedir(), CONFIGURED_HOME_AGENT.cli.homeDirName)
  return {
    [PERSISTED_AGENT_HOME_FIELD]: home,
    defaultAgent: chosen.descriptor.kind,
    ...(await isDirectory(home) ? {} : { claudeDirIsPlaceholder: true }),
  }
}

/**
 * Look for agent CLIs again while nothing is configured, so one installed
 * after Cogpit started is picked up without a restart.
 */
export async function redetectConfig(): Promise<AppConfig | null> {
  return cachedConfig ?? loadConfig()
}

/**
 * Setup's Continue: keep what detection finds, the bundled copy included, and
 * save it so the next start does not ask again. A configuration that already
 * exists is returned unchanged.
 */
export async function adoptDetectedAgents(): Promise<AppConfig | null> {
  const existing = await redetectConfig()
  if (existing) return existing
  const detected = await detectAgentConfig(true)
  if (detected) await saveConfig(detected)
  return detected
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
    // Every shell bootstraps from the agents it finds, and only on a genuinely
    // missing config file: malformed or unreadable user configuration must
    // remain visible instead of being silently ignored.
    cachedConfig = (error as NodeJS.ErrnoException).code === "ENOENT"
      ? await detectAgentConfig(false)
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
        await writeOwnerOnlyJson(CONFIG_PATH, { ...migrated, runtimePluginsVersion: 1 }, CONFIG_FILE_MODE)
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
        edition: configuredEdition(parsed.edition),
        networkAccess: !!parsed.networkAccess,
        networkPassword,
        terminalApp: parsed.terminalApp || undefined,
        editorApp: parsed.editorApp || undefined,
        useBuiltInEditor: !!parsed.useBuiltInEditor,
        agentExecutable: parseExecutableChoice(parsed.agentExecutable),
        projectsRoot: absolutePathOrUndefined(parsed.projectsRoot, "projectsRoot in the config file"),
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
  await writeOwnerOnlyJson(CONFIG_PATH, { ...toPersist, runtimePluginsVersion: 1 }, CONFIG_FILE_MODE)
  cachedConfig = toPersist
  configuredEditionValue = toPersist.edition
}

interface ValidationResult {
  valid: boolean
  error?: string
  resolved?: string
}

/** `~` and `~/…` name the user's home, as in a shell; anything else is returned as is. */
export function expandHome(path: string): string {
  return path === "~" || /^~[\\/]/.test(path) ? join(homedir(), path.slice(1)) : path
}

/**
 * Whether a typed path can be the configured agent's home. Any existing,
 * readable directory can: a CLI that was installed but has not run a session
 * yet has no history folder inside it, and Cogpit reads that folder once it
 * appears.
 */
export async function validateClaudeDir(dirPath: string): Promise<ValidationResult> {
  const resolved = resolve(expandHome(dirPath.trim()))

  try {
    if (!(await stat(resolved)).isDirectory()) {
      return { valid: false, error: "That is a file, not a folder." }
    }
    await readdir(resolved)
  } catch (error) {
    return {
      valid: false,
      error: (error as NodeJS.ErrnoException).code === "ENOENT"
        ? "No folder at that path."
        : "Cogpit cannot open that folder.",
    }
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
