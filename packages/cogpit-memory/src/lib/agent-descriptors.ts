// SHARED SESSION CORE: edit shared/session only; cogpit-memory copies are generated.
/**
 * Static facts about each agent CLI: how it names project directories and
 * session files, and which product capabilities it supports.
 *
 * This module is deliberately parser-free. It imports only `./types`, so a
 * caller that just needs a dirName codec — `server/sessionPaths.ts`, the
 * cogpit-memory CLI, a renderer route guard — does not drag the 40 KB Codex and
 * Copilot transcript parsers along with it. The parsing side of an agent lives
 * behind `AgentFormat` in `./agents`.
 *
 * Everything here is data or pure string math. Anything needing `node:fs` is an
 * `AgentStore` and lives in `server/agents/`, because `shared/` is bundled into
 * the renderer and must stay free of node builtins.
 */
import { AGENT_KINDS, type AgentKind } from "./types"

export type { AgentKind } from "./types"
export { AGENT_KINDS } from "./types"

// ── Capabilities ────────────────────────────────────────────────────────────

/**
 * What a given agent can actually do. Every flag names a *capability*, never an
 * agent — `capabilities.worktrees`, never `kind === "claude"`. That is the whole
 * point: a fourth CLI adds one row here instead of a new arm in 40 conditionals.
 */
export interface AgentCapabilities {
  /** Git worktrees, which Cogpit stores under the Claude projects tree. */
  readonly worktrees: boolean
  /** MCP server configuration can be passed at spawn time. */
  readonly mcp: boolean
  /** `/slash` command discovery and expansion. */
  readonly slashCommands: boolean
  /** The Workflow tool writes run state Cogpit can read back. */
  readonly workflows: boolean
  /** Agent teams (multi-session teammates). */
  readonly agentTeams: boolean
  /** Sub-agent transcripts are written as separate readable files. */
  readonly subagentTranscripts: boolean
  /** Sessions can be published as read-only shares. */
  readonly sharing: boolean
  /**
   * How a long-running goal is tracked: read back from the transcript and set
   * with a slash command, through the CLI's own goal API, or not at all.
   */
  readonly goals: "transcript" | "thread-api" | false
  /** Transcript-rewinding undo is available. */
  readonly undo: boolean
  /** Undo history is persisted, so redo and branches work. */
  readonly redo: boolean
  /** The CLI exposes its own rewind RPC (used instead of replaying edits). */
  readonly nativeRewind: boolean
  /** The CLI checkpoints files itself, so undo can restore them natively. */
  readonly fileCheckpoints: boolean
  /**
   * A reasoning-effort ladder applies by default. When false, effort levels
   * exist only for models whose live catalog entry advertises them.
   */
  readonly reasoningEffort: boolean
  /** A faster/priority service tier can be requested. */
  readonly fastTier: boolean
  /**
   * Images may be attached when the selected model's catalog entry says nothing
   * about its input modalities. When false, vision has to be advertised.
   */
  readonly imageInput: boolean
  /** A plan-then-approve mode exists. */
  readonly planMode: boolean
  /** A message can be delivered into an already-running turn. */
  readonly midTurnSteering: boolean
  /** The whole session can be shut down from the composer. */
  readonly stopSession: boolean
  /** Maximum-effort orchestration mode, pinned to the top effort level. */
  readonly ultracode: boolean
  /** Remaining context can be computed from the transcript. */
  readonly contextWindow: boolean
  /**
   * A session may be driven by a process Cogpit did not start, in which case it
   * is view-only.
   */
  readonly externalProcesses: boolean
  /** The transcript records model substitutions the composer surfaces. */
  readonly modelFallbackNotices: boolean
  /** Whether an unattended "auto" permission mode can be offered. */
  readonly autoPermissionMode: "never" | "per-model" | "always"
  /** Whether composer settings take effect immediately or on the next turn. */
  readonly settingsApply: "live" | "next-turn"
  /**
   * Where turn liveness is read for listings and notifications: the transcript
   * tail, or the runtime's own turn state for a CLI whose transcript lags it.
   */
  readonly turnLiveness: "transcript" | "runtime"
  /** Partial assistant output is published on the stream bus while a turn runs. */
  readonly tokenStreaming: boolean
  /** Branching is a fork RPC on the CLI rather than a copied and cut transcript. */
  readonly nativeFork: boolean
  /** A title can be given to a session when it is created. */
  readonly namedSessions: boolean
}

// ── Descriptor ──────────────────────────────────────────────────────────────

export interface AgentDirNameCodec {
  /**
   * True when `decode(encode(cwd))` can differ from `cwd`, so a caller holding
   * the real dirName must pass it along rather than recompute it.
   */
  readonly lossy: boolean
  /** True when `dirName` belongs to this agent. */
  owns(dirName: string | null | undefined): boolean
  /** Encode a project path as this agent's dirName. */
  encode(cwd: string): string
  /** Decode one of this agent's dirNames back to a project path. */
  decode(dirName: string): string | null
}

export interface AgentSessionFileCodec {
  /** Path of a session's transcript, relative to this agent's sessions root. */
  name(sessionId: string, at?: Date): string
  /** Inverse of `name`: recover the session id, or null if unrecognised. */
  sessionId(fileName: string): string | null
  /**
   * The identifier a URL carries for this transcript. Agents whose on-disk name
   * is rebuildable from the id shorten to it; the rest keep the relative path,
   * because a date-nested rollout cannot be recovered from its uuid alone.
   */
  urlId(fileName: string): string
  /** Exact inverse of `urlId`. */
  fileNameFromUrlId(urlId: string): string
}

export interface AgentResumeCodec {
  /** Copy-pasteable shell command that reopens the session in a terminal. */
  command(sessionId: string, cwd?: string): string
  /** argv handed to `binName` when Cogpit spawns the resume itself. */
  args(sessionId: string): readonly string[]
}

// ── CLI install facts ───────────────────────────────────────────────────────

export interface AgentHomebrewFormula {
  readonly name: string
  /** Casks ship a prebuilt app and need `brew upgrade --cask`. */
  readonly cask: boolean
}

export interface AgentSelfUpdate {
  /** argv appended to `binName` to make the CLI update itself. */
  readonly args: readonly string[]
  /**
   * Whether a resolved binary path belongs to a self-managing install.
   *
   * Paths arrive lowercased and forward-slashed, because the caller normalises
   * every candidate before any predicate runs — these are written against that
   * form and comparing a raw Windows path here would never match.
   */
  matches(normalizedPath: string): boolean
}

/** How a CLI shows up in the machine's process listing. */
export interface AgentProcessMatch {
  /**
   * `"command"`: any command line naming the binary is this CLI, launchers and
   * helpers included. `"executable"`: only a process whose executable is the
   * binary, for a name too common to match loosely.
   */
  readonly by: "command" | "executable"
  /** The session a resumed process was started with, read from its command line. */
  sessionIdFromCommand(command: string): string | null
}

/**
 * Everything Cogpit needs to find, version and upgrade one CLI, plus where that
 * CLI keeps its own state. Cogpit never vendors an agent: it drives whatever
 * the user installed, so all of this is discovery, never assumption.
 */
export interface AgentCli {
  /** npm package publishing this CLI. */
  readonly packageName: string
  readonly homebrew: AgentHomebrewFormula | null
  readonly wingetId: string | null
  /** argv that makes the CLI print its version. */
  readonly versionArgs: readonly string[]
  readonly selfUpdate: AgentSelfUpdate | null
  /** Directory holding the CLI's own state, relative to the user's home. */
  readonly homeDirName: string
  /** Environment variable overriding that directory, if the CLI has one. */
  readonly homeEnvVar: string | null
  /**
   * Path inside the home whose existence proves the CLI has been used. Empty
   * when the home directory itself is the evidence.
   */
  readonly installMarker: string
  /**
   * Whether Cogpit can locate this home on its own. Claude's is a user-chosen
   * path stored in Cogpit's own configuration, so it cannot be discovered when
   * that configuration is missing; the rest sit at a fixed, env-overridable
   * location and can be found on a first run.
   */
  readonly homeIsDiscoverable: boolean
  readonly process: AgentProcessMatch
}

// ── Config-file layout ──────────────────────────────────────────────────────

export type AgentConfigScope = "global" | "project"

export interface AgentConfigFile {
  /**
   * `"scope"` places the file beside the config root — in the user's home
   * directory or at the project root — and `"root"` places it inside it.
   */
  readonly in: "scope" | "root"
  /** Path relative to whichever of those two directories `in` names. */
  readonly path: string
  /** Scopes at which this file exists. */
  readonly scopes: readonly AgentConfigScope[]
  /** Tree label; defaults to `path`. */
  readonly label?: string
}

/**
 * Where a CLI reads its instructions, settings and extensions from. Drives the
 * config browser, so an agent missing a row here is an agent the user cannot
 * configure through Cogpit at all.
 */
export interface AgentConfigLayout {
  /** Directory the CLI reads config from, under the home or a project root. */
  readonly rootDirName: string
  readonly instructions: readonly AgentConfigFile[]
  readonly settings: readonly AgentConfigFile[]
  /** Directories inside the config root; null when the CLI has no such concept. */
  readonly skillsDir: string | null
  readonly agentsDir: string | null
  /** Codex calls these "prompts". */
  readonly commandsDir: string | null
  /** Global-only theme directory, if the CLI has one. */
  readonly themesDir: string | null
  /** Global-only installed-plugin tree, if the CLI has one. */
  readonly pluginsDir: string | null
}

// ── Context window ──────────────────────────────────────────────────────────

export interface AgentContextWindow {
  /** Window assumed for a model with no entry in `limits`. */
  readonly defaultLimit: number
  /** Model-id substrings with a different window; first match wins. */
  readonly limits: readonly { readonly match: string; readonly limit: number }[]
  /**
   * Headroom the CLI reserves before it auto-compacts. Zero for a CLI that
   * decides its own compaction point, so applying another's reserve would
   * report a session as nearly full while it still has room.
   */
  readonly compactBuffer: number
  /** Model-id marker requesting an extended window, if the CLI has one. */
  readonly extendedContext: { readonly marker: string; readonly limit: number } | null
}

// ── Launch arguments ────────────────────────────────────────────────────────

/**
 * Cogpit's access picker, as it crosses the wire. Every field is optional
 * because it arrives from a client that may be older than the server; each
 * agent maps it onto its own policy vocabulary.
 */
export interface PermissionsConfig {
  mode?: string
  allowedTools?: string[]
  disallowedTools?: string[]
}

/**
 * argv Cogpit appends to `binName` when it launches a turn. Each function
 * returns an empty array when the setting was not chosen, so call sites spread
 * them unconditionally.
 */
export interface AgentLaunchArgs {
  /** Translate the access picker into this CLI's own policy flags. */
  permissions(permissions?: PermissionsConfig): string[]
  model(model?: string): string[]
  effort(effort?: string): string[]
  fastTier(enabled?: boolean): string[]
}

/**
 * The wire values a "fast mode" request carries.
 *
 * An agent Cogpit drives two ways can want two different spellings of the same
 * intent, and they are recorded separately rather than merged, because only the
 * CLI itself can say which is right.
 */
export interface AgentServiceTier {
  /** `serviceTier` sent over a persistent RPC/app-server connection. */
  readonly appServerValue: string
  /** `service_tier` written into the CLI's own config when it is spawned. */
  readonly cliConfigValue: string
}

// ── Model catalog ───────────────────────────────────────────────────────────

export interface EffortOption {
  value: string
  label: string
  description?: string
}

export interface ServiceTierOption {
  value: string
  label: string
  description?: string
}

/** One row of a model picker, and one entry of the `/api/models` catalog. */
export interface ModelOption {
  value: string
  label: string
  description?: string
  /** Canonical wire model id this option resolves to (`""` is the default). */
  resolvedModel?: string
  isDefault?: boolean
  defaultReasoningEffort?: string
  supportedReasoningEfforts?: EffortOption[]
  inputModalities?: string[]
  supportsPersonality?: boolean
  serviceTiers?: ServiceTierOption[]
  availabilityMessage?: string
  supportsEffort?: boolean
  supportsAdaptiveThinking?: boolean
  supportsAutoMode?: boolean
}

export interface AgentDescriptor {
  readonly kind: AgentKind
  /** Human-facing product name. */
  readonly displayName: string
  /** Executable name, as invoked on PATH. */
  readonly binName: string
  readonly dirName: AgentDirNameCodec
  readonly sessionFile: AgentSessionFileCodec
  /**
   * Whether header metadata is complete after reading only the first bytes of a
   * transcript. False when an exact line count or the last user message matters
   * and nothing short of a full read can produce them, which is what makes a
   * partial head read a false economy for that agent.
   */
  readonly metadataFromHead: boolean
  readonly resume: AgentResumeCodec
  readonly launchArgs: AgentLaunchArgs
  /** Null for an agent with no faster tier, or one that asks for it some other way. */
  readonly serviceTier: AgentServiceTier | null
  readonly cli: AgentCli
  readonly config: AgentConfigLayout
  readonly contextWindow: AgentContextWindow
  readonly capabilities: AgentCapabilities
}

// ── dirName encodings ───────────────────────────────────────────────────────

const SESSION_UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"
const SESSION_UUID_RE = new RegExp(`^${SESSION_UUID}$`, "i")

/**
 * URL-safe base64 without padding. Codex and Copilot both address projects by
 * their absolute path, which has to survive being a single directory name.
 */
function encodeBase64DirName(prefix: string, cwd: string): string {
  const bytes = new TextEncoder().encode(cwd)
  let binary = ""
  for (const byte of bytes) binary += String.fromCharCode(byte)
  const encoded = btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
  return `${prefix}${encoded}`
}

function decodeBase64DirName(prefix: string, dirName: string): string | null {
  if (!dirName.startsWith(prefix)) return null
  try {
    const encoded = dirName.slice(prefix.length).replace(/-/g, "+").replace(/_/g, "/")
    const binary = atob(encoded)
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0))
    return new TextDecoder().decode(bytes)
  } catch {
    return null
  }
}

function base64DirNameCodec(prefix: string): AgentDirNameCodec {
  return {
    lossy: false,
    owns: (dirName) => typeof dirName === "string" && dirName.startsWith(prefix),
    encode: (cwd) => encodeBase64DirName(prefix, cwd),
    decode: (dirName) => decodeBase64DirName(prefix, dirName),
  }
}

/** The trailing-uuid grammar Claude and Codex transcripts share. */
function sessionIdFromJsonlName(fileName: string): string | null {
  const match = new RegExp(`(${SESSION_UUID})\\.jsonl$`, "i").exec(fileName)
  return match ? match[1] : null
}

/**
 * URL form for an agent whose transcript path is already URL-safe: drop the
 * extension and put it back. Dropping it happens to yield the session id for a
 * top-level transcript, while keeping the relative path a nested one needs —
 * `<parent>/subagents/agent-<id>.jsonl` and a date-nested rollout both survive.
 */
const jsonlPathUrlCodec = {
  urlId: (fileName: string) => fileName.replace(/\.jsonl$/, ""),
  fileNameFromUrlId: (urlId: string) => urlId.endsWith(".jsonl") ? urlId : `${urlId}.jsonl`,
}

/** Single-quote a path so it survives a copy-paste into a POSIX shell. */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

/** `["--flag", value]` when the setting was chosen, nothing when it was not. */
function flag(name: string, value?: string): string[] {
  return value ? [name, value] : []
}

/** First capture of `pattern` in `command`, or null. */
function commandCapture(command: string, pattern: RegExp): string | null {
  return pattern.exec(command)?.[1] ?? null
}

/** Session ids as they appear in argv: a UUID, matched loosely by shape. */
const ARGV_SESSION_ID = "[0-9a-f-]{36}"

/** The executable of a command line, without its directory. */
function commandExecutableName(command: string): string {
  const match = /^(?:"([^"]+)"(?=\s|$)|'([^']+)'(?=\s|$)|(\S+))/.exec(command.trimStart())
  const executable = match?.[1] ?? match?.[2] ?? match?.[3] ?? ""
  return executable.split(/[\\/]/).pop() ?? ""
}

/** True when a process listing's command line belongs to this CLI. */
export function matchesAgentProcess(descriptor: AgentDescriptor, command: string): boolean {
  if (descriptor.cli.process.by === "executable") {
    return new RegExp(`^${descriptor.binName}(?:\\.exe)?$`, "i").test(commandExecutableName(command))
  }
  return command.includes(descriptor.binName)
}

/** The `Win32_Process` name filter that lists this CLI, for `Get-CimInstance`. */
export function windowsProcessNameFilter(descriptor: AgentDescriptor): string {
  return descriptor.cli.process.by === "executable"
    ? `name = '${descriptor.binName}.exe'`
    : `name like '%${descriptor.binName}%'`
}

export const CODEX_DIR_PREFIX = "codex__"
export const COPILOT_DIR_PREFIX = "copilot__"

// ── Claude ──────────────────────────────────────────────────────────────────

/** Modes the Claude CLI accepts after `--permission-mode`. */
const CLAUDE_PERMISSION_MODES = new Set(["default", "plan", "acceptEdits", "dontAsk", "auto"])

const claude: AgentDescriptor = {
  kind: "claude",
  displayName: "Claude Code",
  binName: "claude",
  dirName: {
    lossy: true,
    // Claude has no prefix: it owns every dirName no other agent claims. The
    // registry checks the prefixed agents first, so this is only ever reached
    // as the terminal arm.
    owns: (dirName) =>
      typeof dirName === "string"
      && !dirName.startsWith(CODEX_DIR_PREFIX)
      && !dirName.startsWith(COPILOT_DIR_PREFIX),
    /**
     * Claude Code's own convention: every character outside `[A-Za-z0-9]`
     * becomes `-`, so `/Users/x/proj` and `C:\Users\x\proj` both collapse into a
     * flat name under `~/.claude/projects`.
     */
    encode: (cwd) => (cwd.replace(/[\\/]+$/, "") || cwd).replace(/[^a-zA-Z0-9]/g, "-"),
    /**
     * Best-effort inverse. The encoding is lossy — a literal `-` is
     * indistinguishable from a separator — so a caller that can read the
     * session's recorded `cwd` should always prefer that.
     */
    decode: (dirName) => {
      const windowsDrive = /^([A-Za-z])--(.*)$/.exec(dirName)
      if (windowsDrive) return `${windowsDrive[1]}:\\${windowsDrive[2].replace(/-/g, "\\")}`
      return "/" + dirName.replace(/^-/, "").replace(/-/g, "/")
    },
  },
  sessionFile: {
    name: (sessionId) => `${sessionId}.jsonl`,
    sessionId: sessionIdFromJsonlName,
    ...jsonlPathUrlCodec,
  },
  metadataFromHead: true,
  resume: {
    command: (sessionId) => `claude --resume ${sessionId}`,
    args: (sessionId) => ["--resume", sessionId],
  },
  launchArgs: {
    permissions: (permissions) => {
      // A missing mode is NOT a bypass: it falls back to the safe default.
      if (!permissions?.mode) return ["--permission-mode", "default"]
      if (permissions.mode === "bypassPermissions") return ["--dangerously-skip-permissions"]
      return [
        ...(CLAUDE_PERMISSION_MODES.has(permissions.mode)
          ? ["--permission-mode", permissions.mode]
          : []),
        ...(permissions.allowedTools ?? []).flatMap((tool) => ["--allowedTools", tool]),
        ...(permissions.disallowedTools ?? []).flatMap((tool) => ["--disallowedTools", tool]),
      ]
    },
    model: (model) => flag("--model", model),
    effort: (effort) => flag("--effort", effort),
    // Claude's faster tier is a setting on the live Agent SDK query, not a flag.
    fastTier: () => [],
  },
  serviceTier: null,
  cli: {
    packageName: "@anthropic-ai/claude-code",
    homebrew: { name: "claude-code", cask: false },
    wingetId: null,
    versionArgs: ["--version"],
    selfUpdate: {
      args: ["update"],
      matches: (path) =>
        path.endsWith("/.local/bin/claude")
        || path.endsWith("/.local/bin/claude.exe")
        || path.includes("/.local/share/claude/"),
    },
    homeDirName: ".claude",
    homeEnvVar: null,
    installMarker: "projects",
    homeIsDiscoverable: false,
    process: {
      by: "command",
      sessionIdFromCommand: (command) =>
        commandCapture(command, new RegExp(`--resume(?:=|\\s+)(${ARGV_SESSION_ID})`))
        ?? commandCapture(command, new RegExp(`--session-id(?:=|\\s+)(${ARGV_SESSION_ID})`)),
    },
  },
  config: {
    rootDirName: ".claude",
    instructions: [
      { in: "scope", path: "CLAUDE.md", scopes: ["global", "project"] },
      { in: "root", path: "CLAUDE.md", label: ".claude/CLAUDE.md", scopes: ["project"] },
    ],
    settings: [
      { in: "root", path: "settings.json", scopes: ["global"] },
      { in: "root", path: "settings.local.json", scopes: ["project"] },
    ],
    skillsDir: "skills",
    agentsDir: "agents",
    commandsDir: "commands",
    themesDir: "themes",
    pluginsDir: "plugins",
  },
  contextWindow: {
    // Anything not listed is treated as current-generation, so a model released
    // after this table was written reports the larger window rather than a
    // stale small one. Limits are LiteLLM `max_input_tokens`, the same table the
    // cost code prices against. Deliberately not family-based: sonnet-4-5 is
    // 200k while sonnet-4-6 is 1M.
    defaultLimit: 1_000_000,
    limits: [
      { match: "claude-haiku-4-5", limit: 200_000 },
      { match: "claude-haiku-4-1", limit: 200_000 },
      { match: "claude-sonnet-4-5", limit: 200_000 },
      { match: "claude-opus-4-5", limit: 200_000 },
      { match: "claude-opus-4-1", limit: 200_000 },
    ],
    compactBuffer: 33_000,
    extendedContext: { marker: "[1m]", limit: 1_000_000 },
  },
  capabilities: {
    worktrees: true,
    mcp: true,
    slashCommands: true,
    workflows: true,
    agentTeams: true,
    subagentTranscripts: true,
    sharing: true,
    goals: "transcript",
    undo: true,
    redo: true,
    nativeRewind: false,
    fileCheckpoints: true,
    reasoningEffort: true,
    fastTier: true,
    imageInput: true,
    planMode: true,
    midTurnSteering: false,
    stopSession: true,
    ultracode: true,
    contextWindow: true,
    externalProcesses: false,
    modelFallbackNotices: true,
    autoPermissionMode: "per-model",
    settingsApply: "live",
    turnLiveness: "transcript",
    tokenStreaming: true,
    nativeFork: false,
    namedSessions: true,
  },
}

// ── Codex ───────────────────────────────────────────────────────────────────

/**
 * Codex is driven two ways, and the two transports were given different wire
 * values for the same "fast mode" request: the app-server connection sends
 * `serviceTier: "priority"`, while a spawned `codex exec` is configured with
 * `service_tier="fast"`. That disagreement predates this table and cannot be
 * settled without a live CLI to try both against, so both spellings are
 * preserved verbatim and declared side by side instead of one being picked
 * silently. Once someone can verify which the CLI actually honours, this
 * collapses to a single value.
 */
const CODEX_SERVICE_TIER: AgentServiceTier = {
  appServerValue: "priority",
  cliConfigValue: "fast",
}

const codex: AgentDescriptor = {
  kind: "codex",
  displayName: "Codex",
  binName: "codex",
  dirName: base64DirNameCodec(CODEX_DIR_PREFIX),
  sessionFile: {
    /**
     * Codex nests rollouts by local date:
     * `YYYY/MM/DD/rollout-YYYY-MM-DDTHH-MM-SS-<sessionId>.jsonl`.
     */
    name: (sessionId, at = new Date()) => {
      const year = String(at.getFullYear())
      const month = String(at.getMonth() + 1).padStart(2, "0")
      const day = String(at.getDate()).padStart(2, "0")
      const hour = String(at.getHours()).padStart(2, "0")
      const minute = String(at.getMinutes()).padStart(2, "0")
      const second = String(at.getSeconds()).padStart(2, "0")
      return `${year}/${month}/${day}/rollout-${year}-${month}-${day}T${hour}-${minute}-${second}-${sessionId}.jsonl`
    },
    sessionId: sessionIdFromJsonlName,
    // The date nesting is unrecoverable from the id, so the URL keeps the path.
    ...jsonlPathUrlCodec,
  },
  // A rollout's header carries no turn count and no last user message; both
  // only settle at the end of the file.
  metadataFromHead: false,
  resume: {
    command: (sessionId, cwd) => cwd
      ? `codex -C ${shellQuote(cwd)} resume ${sessionId}`
      : `codex resume ${sessionId}`,
    args: (sessionId) => ["resume", sessionId],
  },
  launchArgs: {
    permissions: (permissions) => {
      const mode = permissions?.mode || "default"
      if (mode === "bypassPermissions") return ["--dangerously-bypass-approvals-and-sandbox"]
      // `codex exec` is non-interactive, so it cannot present an approval
      // prompt. Keep execution inside a sandbox and return denied operations to
      // the model instead of silently granting full machine access. The
      // app-server adapter upgrades this to interactive approvals when it owns
      // the live thread.
      return [
        "--sandbox",
        mode === "plan" ? "read-only" : "workspace-write",
        "-c",
        'approval_policy="never"',
      ]
    },
    model: (model) => flag("-m", model),
    effort: (effort) => effort ? ["-c", `model_reasoning_effort=${JSON.stringify(effort)}`] : [],
    fastTier: (enabled) => enabled
      ? [
          "-c",
          `service_tier=${JSON.stringify(CODEX_SERVICE_TIER.cliConfigValue)}`,
          "--enable",
          "fast_mode",
        ]
      : [],
  },
  serviceTier: CODEX_SERVICE_TIER,
  cli: {
    packageName: "@openai/codex",
    homebrew: { name: "codex", cask: false },
    wingetId: null,
    versionArgs: ["--version"],
    // Codex ships no self-updater; a hand-placed binary has to be replaced by
    // whatever put it there.
    selfUpdate: null,
    homeDirName: ".codex",
    homeEnvVar: "CODEX_HOME",
    installMarker: "",
    homeIsDiscoverable: true,
    process: {
      by: "command",
      sessionIdFromCommand: (command) => commandCapture(
        command,
        new RegExp(`codex(?:\\s+\\S+)*\\s+exec\\s+resume\\s+(${ARGV_SESSION_ID})`),
      ),
    },
  },
  config: {
    rootDirName: ".codex",
    instructions: [{ in: "scope", path: "AGENTS.md", scopes: ["global", "project"] }],
    settings: [{ in: "root", path: "config.toml", scopes: ["global", "project"] }],
    skillsDir: "skills",
    agentsDir: "agents",
    commandsDir: "prompts",
    themesDir: null,
    pluginsDir: null,
  },
  contextWindow: {
    // The GPT-5 family window. A rollout that reports `model_context_window`
    // overrides this; it is only the fallback for a model Cogpit has not seen.
    defaultLimit: 272_000,
    limits: [],
    // Codex decides its own compaction point and never publishes a reserve.
    compactBuffer: 0,
    extendedContext: null,
  },
  capabilities: {
    worktrees: false,
    mcp: false,
    slashCommands: false,
    workflows: false,
    agentTeams: false,
    subagentTranscripts: true,
    sharing: false,
    goals: "thread-api",
    undo: true,
    redo: true,
    nativeRewind: false,
    fileCheckpoints: false,
    reasoningEffort: true,
    fastTier: true,
    imageInput: true,
    planMode: true,
    midTurnSteering: true,
    stopSession: false,
    ultracode: false,
    contextWindow: false,
    externalProcesses: false,
    modelFallbackNotices: false,
    autoPermissionMode: "never",
    settingsApply: "next-turn",
    turnLiveness: "runtime",
    tokenStreaming: true,
    nativeFork: false,
    // Codex derives its own thread name.
    namedSessions: false,
  },
}

// ── Copilot ─────────────────────────────────────────────────────────────────

const copilot: AgentDescriptor = {
  kind: "copilot",
  displayName: "GitHub Copilot CLI",
  binName: "copilot",
  dirName: base64DirNameCodec(COPILOT_DIR_PREFIX),
  sessionFile: {
    /** Copilot keeps one directory per session: `<uuid>/events.jsonl`. */
    name: (sessionId) => `${sessionId}/events.jsonl`,
    sessionId: (fileName) => {
      const match = new RegExp(`^(${SESSION_UUID})/events\\.jsonl$`, "i").exec(fileName)
      return match ? match[1] : null
    },
    // `<id>/events.jsonl` rebuilds from the id, so URLs stay short.
    urlId: (fileName) => {
      const match = new RegExp(`^(${SESSION_UUID})/events\\.jsonl$`, "i").exec(fileName)
      return match ? match[1] : fileName.replace(/\.jsonl$/, "")
    },
    fileNameFromUrlId: (urlId) =>
      urlId.endsWith(".jsonl") ? urlId : `${urlId}/events.jsonl`,
  },
  metadataFromHead: true,
  resume: {
    command: (sessionId, cwd) => cwd
      ? `copilot -C ${shellQuote(cwd)} --resume ${sessionId}`
      : `copilot --resume ${sessionId}`,
    args: (sessionId) => [`--resume=${sessionId}`],
  },
  // Cogpit launches Copilot as a stdio RPC server and configures each turn
  // afterwards, over `session.create` and `session.setPermissionMode`. These are
  // the flags its CLI accepts for the same settings when it is driven straight
  // from a shell instead.
  launchArgs: {
    permissions: (permissions) =>
      permissions?.mode === "bypassPermissions" || permissions?.mode === "auto"
        ? ["--allow-all"]
        : [],
    model: (model) => flag("--model", model),
    effort: (effort) => flag("--reasoning-effort", effort),
    fastTier: () => [],
  },
  serviceTier: null,
  cli: {
    packageName: "@github/copilot",
    homebrew: { name: "copilot-cli", cask: true },
    wingetId: "GitHub.Copilot",
    versionArgs: ["--version"],
    selfUpdate: {
      args: ["update"],
      // `/usr/local/bin/copilot` is also an npm prefix, so this is only ever
      // reached after the package-manager checks have declined — which they can
      // only do because the caller passes the realpath in as well.
      matches: (path) =>
        path.endsWith("/.local/bin/copilot") || path === "/usr/local/bin/copilot",
    },
    homeDirName: ".copilot",
    homeEnvVar: "COPILOT_HOME",
    installMarker: "session-state",
    homeIsDiscoverable: true,
    // `copilot` is too common a word to match loosely: editor extensions and
    // unrelated tools name it in their argv.
    process: {
      by: "executable",
      sessionIdFromCommand: (command) =>
        commandCapture(command, new RegExp(`--resume(?:=|\\s+)(${ARGV_SESSION_ID})`)),
    },
  },
  config: {
    rootDirName: ".copilot",
    // Copilot reads the same cross-CLI instruction file Codex does, so the two
    // entries merge into one row carrying both badges.
    instructions: [{ in: "scope", path: "AGENTS.md", scopes: ["global", "project"] }],
    settings: [{ in: "root", path: "config.json", scopes: ["global"] }],
    skillsDir: "skills",
    agentsDir: null,
    commandsDir: null,
    themesDir: null,
    pluginsDir: null,
  },
  contextWindow: {
    // Copilot brokers models from several vendors, so this is the smallest
    // window any of them offers rather than a per-model table Cogpit cannot
    // keep current.
    defaultLimit: 200_000,
    limits: [],
    compactBuffer: 0,
    extendedContext: null,
  },
  capabilities: {
    worktrees: false,
    mcp: false,
    slashCommands: false,
    workflows: false,
    agentTeams: false,
    subagentTranscripts: false,
    sharing: false,
    goals: false,
    undo: true,
    // Copilot persists no undo state of its own, so there is nothing to redo
    // from and no branch history to show.
    redo: false,
    nativeRewind: true,
    fileCheckpoints: false,
    // Effort is only offered for models whose catalog entry advertises it.
    reasoningEffort: false,
    fastTier: false,
    imageInput: false,
    planMode: true,
    midTurnSteering: true,
    stopSession: true,
    ultracode: false,
    contextWindow: false,
    externalProcesses: true,
    modelFallbackNotices: false,
    autoPermissionMode: "always",
    settingsApply: "next-turn",
    turnLiveness: "runtime",
    tokenStreaming: false,
    nativeFork: true,
    namedSessions: true,
  },
}

// ── Registry ────────────────────────────────────────────────────────────────

const DESCRIPTORS: Readonly<Record<AgentKind, AgentDescriptor>> = Object.freeze({
  claude,
  codex,
  copilot,
})

export function descriptorFor(kind: AgentKind): AgentDescriptor {
  return DESCRIPTORS[kind]
}

export function allDescriptors(): readonly AgentDescriptor[] {
  return AGENT_KINDS.map((kind) => DESCRIPTORS[kind])
}

/**
 * The one agent with a given property, for code that only makes sense while
 * exactly one has it — the configured home, the slash-command palette. Fails
 * loudly on zero or several rather than silently picking the first, so a
 * capability a second agent gains is noticed instead of misrouted.
 */
export function soleDescriptorWhere(
  predicate: (descriptor: AgentDescriptor) => boolean,
  what: string,
): AgentDescriptor {
  const matches = allDescriptors().filter(predicate)
  if (matches.length !== 1) {
    throw new Error(`Expected exactly one agent with ${what}, found ${matches.length}`)
  }
  return matches[0]
}

/**
 * Resolve the agent that owns a project dirName.
 *
 * This is Cogpit's **source of truth** for "which agent is this session?". It
 * beats content sniffing because it is known before a single byte is read, it
 * is what the URL carries, and it is what every write path (spawn, undo,
 * branch) already keys on. `ParsedSession.agentKind` is the parser's own
 * finding and is used to cross-check, never to override.
 *
 * Falls back to Claude for a null/unknown dirName, matching the historical
 * behaviour every caller depends on.
 */
export function descriptorForDirName(dirName: string | null | undefined): AgentDescriptor {
  for (const kind of AGENT_KINDS) {
    if (kind === "claude") continue
    if (DESCRIPTORS[kind].dirName.owns(dirName)) return DESCRIPTORS[kind]
  }
  return claude
}

/** Convenience wrapper: the agent kind owning a project dirName. */
export function agentKindForDirName(dirName: string | null | undefined): AgentKind {
  return descriptorForDirName(dirName).kind
}

/**
 * Encode a project path for a given agent. An agent whose encoding is lossy
 * cannot recover its canonical dirName from the path, so a caller that already
 * holds it passes it as `knownDirName` rather than let it be re-derived.
 */
export function projectDirNameFor(
  kind: AgentKind,
  cwd: string,
  knownDirName?: string,
): string {
  const codec = DESCRIPTORS[kind].dirName
  if (knownDirName && codec.lossy) return knownDirName
  return codec.encode(cwd)
}

/** True when `fileName` looks like a session transcript for `kind`. */
export function sessionIdFromFileName(kind: AgentKind, fileName: string): string | null {
  return DESCRIPTORS[kind].sessionFile.sessionId(fileName)
}

/** True when `value` is a bare session UUID. */
export function isSessionUuid(value: string): boolean {
  return SESSION_UUID_RE.test(value)
}
