import type { CloudflareIntegrationRequest } from "@cogpit/plugin-contracts"
import type {
  CloudflareBinding,
  CloudflareDeployment,
  CloudflareDeploymentsResponse,
  CloudflareEnvironment,
  CloudflareErrorCode,
  CloudflareVersion,
  CloudflareVersionResponse,
  CloudflareWorkspace,
} from "@cogpit/plugin-integrations"
import { execFile as execFileCallback } from "node:child_process"
import { access, readdir, readFile, stat } from "node:fs/promises"
import { dirname, join, relative, sep } from "node:path"
import { promisify } from "node:util"
import { parse as parseToml } from "smol-toml"
import { resolveAgentCommand } from "../../lib/binaryResolver"
import { canonicalDirectory, findNearestProjectRoot } from "../../lib/projectRoot"
import { resolveGitProject } from "../../lib/gitProject"
import { isWithinDir } from "../../pathSafety"
import { nullableString, record, stringValue } from "../../routes/apiValues"
import type { PluginIntegrationContext } from "../integrationTypes"

const execFile = promisify(execFileCallback)
const CONFIG_NAMES = ["wrangler.json", "wrangler.jsonc", "wrangler.toml"] as const
const MAX_CONFIG_BYTES = 256 * 1024
const DEFAULT_DEPLOYMENT_LIMIT = 20
const MAX_DEPLOYMENT_LIMIT = 30
/** `wrangler whoami --json` arrived in 4.65.0; every other command used here is older. */
const MINIMUM_CLI_VERSION = [4, 65, 0] as const
const ENVIRONMENT_NAME = /^[A-Za-z0-9_-]+$/
const VERSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const ACCOUNT_ID = /^[0-9a-f]{32}$/

type WranglerConfig = Record<string, unknown>

export interface WranglerProject {
  /** Directory holding the configuration file; Wrangler runs here. */
  root: string
  configPath: string
  /** Configuration path relative to the repository root, or to the workspace outside a repository. Selects the project in requests. */
  key: string
  /** Repository root when the workspace is inside a Git worktree. Bounds the search for a project-local Wrangler. */
  repositoryRoot: string | null
  config: WranglerConfig
}

interface CommandResult {
  stdout: string
  stderr: string
}

export type WranglerCommandRunner = (project: WranglerProject, args: string[], context: PluginIntegrationContext) => Promise<CommandResult>

export interface CloudflareDependencies {
  /** Every Wrangler project reachable from the workspace, nearest first. */
  resolveProjects: (cwd: string, signal?: AbortSignal) => Promise<WranglerProject[]>
  wrangler: (project: WranglerProject, args: string[], context: PluginIntegrationContext) => Promise<unknown>
  environment?: NodeJS.ProcessEnv
}

export class CloudflareRouteError extends Error {
  constructor(readonly status: number, readonly code: CloudflareErrorCode, message: string) {
    super(message)
  }
}

function invalidConfig(message: string): CloudflareRouteError {
  return new CloudflareRouteError(400, "cloudflare_config_invalid", message)
}

function unsupportedCli(): CloudflareRouteError {
  return new CloudflareRouteError(503, "wrangler_too_old", `Update Wrangler to ${MINIMUM_CLI_VERSION.join(".")} or newer to view deployments`)
}

function endOfString(text: string, start: number): number {
  let index = start + 1
  while (index < text.length && text[index] !== "\"") index += text[index] === "\\" ? 2 : 1
  return index
}

interface Rewrite {
  emit: string
  /** Last index of the source this rewrite consumes. */
  consumedTo: number
}

/** Copy `text`, passing every character outside a string literal to `rewrite` and leaving literals untouched. */
function rewriteOutsideStrings(text: string, rewrite: (index: number) => Rewrite | null): string {
  let output = ""
  for (let index = 0; index < text.length; index++) {
    if (text[index] === "\"") {
      const end = endOfString(text, index)
      output += text.slice(index, end + 1)
      index = end
      continue
    }
    const replacement = rewrite(index)
    if (!replacement) { output += text[index]; continue }
    output += replacement.emit
    index = replacement.consumedTo
  }
  return output
}

/** Strip `//` and `/* *\/` comments plus trailing commas, outside string literals, so `wrangler.jsonc` parses with JSON.parse. */
export function parseJsonc(text: string): unknown {
  const withoutComments = rewriteOutsideStrings(text, index => {
    if (text[index] !== "/") return null
    if (text[index + 1] === "/") { const end = text.indexOf("\n", index); return { emit: "\n", consumedTo: end === -1 ? text.length : end } }
    if (text[index + 1] === "*") { const end = text.indexOf("*/", index + 2); return { emit: "", consumedTo: end === -1 ? text.length : end + 1 } }
    return null
  })
  const json = rewriteOutsideStrings(withoutComments, index => (
    withoutComments[index] === "," && /^\s*[}\]]/.test(withoutComments.slice(index + 1)) ? { emit: "", consumedTo: index } : null
  ))
  return JSON.parse(json)
}

function parseConfigText(name: string, text: string): WranglerConfig {
  try {
    const value = name.endsWith(".toml") ? parseToml(text) : parseJsonc(text)
    const config = record(value)
    if (!config) throw new Error("not an object")
    return config
  } catch {
    throw invalidConfig(`Unable to parse ${name}`)
  }
}

async function readWranglerConfig(directory: string): Promise<{ configPath: string; config: WranglerConfig } | null> {
  for (const name of CONFIG_NAMES) {
    const configPath = join(directory, name)
    let info
    try {
      info = await stat(configPath)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue
      throw invalidConfig(`Unable to read ${name}`)
    }
    if (!info.isFile() || info.size > MAX_CONFIG_BYTES) throw invalidConfig(`Unable to read ${name}`)
    return { configPath, config: parseConfigText(name, await readFile(configPath, "utf8")) }
  }
  return null
}

const SKIPPED_DIRECTORIES = new Set(["node_modules", "dist", "build", "out", "coverage", "target", "vendor", "tmp"])
const MAX_SCAN_DEPTH = 3
const MAX_SCAN_DIRECTORIES = 400

type FoundConfig = { configPath: string; config: WranglerConfig }

/** Breadth-first search below `root` for Wrangler projects, skipping dependency and build output folders. */
async function scanChildProjects(root: string, signal?: AbortSignal): Promise<{ root: string; found: FoundConfig }[]> {
  const results: { root: string; found: FoundConfig }[] = []
  const queue: { directory: string; depth: number }[] = [{ directory: root, depth: 0 }]
  let visited = 0
  while (queue.length && visited < MAX_SCAN_DIRECTORIES) {
    const { directory, depth } = queue.shift()!
    signal?.throwIfAborted()
    visited++
    if (depth > 0) {
      let found: FoundConfig | null
      try {
        found = await readWranglerConfig(directory)
      } catch (error) {
        if (error instanceof CloudflareRouteError) continue
        throw error
      }
      if (found) { results.push({ root: directory, found }); continue }
    }
    if (depth >= MAX_SCAN_DEPTH) continue
    let entries
    try { entries = await readdir(directory, { withFileTypes: true }) } catch { continue }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith(".") || SKIPPED_DIRECTORIES.has(entry.name)) continue
      queue.push({ directory: join(directory, entry.name), depth: depth + 1 })
    }
  }
  return results.sort((left, right) => left.root < right.root ? -1 : left.root > right.root ? 1 : 0)
}

/**
 * Wrangler projects for a workspace: the nearest configuration between the
 * session directory and its repository root, or, when there is none, every
 * project found in the workspace's child directories.
 */
export async function discoverWranglerProjects(cwd: string, signal?: AbortSignal): Promise<WranglerProject[]> {
  signal?.throwIfAborted()
  const root = await canonicalDirectory(cwd)
  if (!root) throw new CloudflareRouteError(404, "cloudflare_config_missing", "Project directory not found")
  const nearest = await findNearestProjectRoot(root, readWranglerConfig, signal)
  const candidates = nearest ? [{ root: nearest.root, found: nearest.value }] : await scanChildProjects(root, signal)
  if (!candidates.length) {
    throw new CloudflareRouteError(400, "cloudflare_config_missing", "Add a wrangler.jsonc or wrangler.toml to this workspace, its repository root or one of its folders to view deployments")
  }
  const repository = await resolveGitProject(root, signal)
  const repositoryRoot = repository.ok ? repository.root : null
  return candidates.map(({ root: projectRoot, found }) => ({
    root: projectRoot,
    configPath: found.configPath,
    key: relative(repositoryRoot ?? root, found.configPath).split(sep).join("/"),
    repositoryRoot,
    config: found.config,
  }))
}

export function selectWranglerProject(projects: WranglerProject[], key: string | undefined): WranglerProject {
  if (key === undefined) return projects[0]
  const project = projects.find(entry => entry.key === key)
  if (!project) throw invalidConfig(`Configuration ${key} is not part of this workspace`)
  return project
}

interface BindingKind {
  type: string
  path?: string[]
  single?: boolean
  name?: string
  target?: string
}

const BINDING_KINDS: readonly BindingKind[] = [
  { type: "kv_namespaces" },
  { type: "d1_databases", target: "database_name" },
  { type: "r2_buckets", target: "bucket_name" },
  { type: "durable_objects", path: ["durable_objects", "bindings"], name: "name", target: "class_name" },
  { type: "queues.producers", path: ["queues", "producers"], target: "queue" },
  { type: "queues.consumers", path: ["queues", "consumers"], name: "queue" },
  { type: "services", target: "service" },
  { type: "workflows", target: "name" },
  { type: "vectorize", target: "index_name" },
  { type: "hyperdrive" },
  { type: "analytics_engine_datasets", target: "dataset" },
  { type: "send_email", name: "name" },
  { type: "secrets_store_secrets", target: "secret_name" },
  { type: "mtls_certificates" },
  { type: "dispatch_namespaces", target: "namespace" },
  { type: "pipelines", target: "pipeline" },
  { type: "ai", single: true },
  { type: "browser", single: true },
  { type: "images", single: true },
  { type: "version_metadata", single: true },
  { type: "assets", single: true, target: "directory" },
]

function bindingEntries(section: WranglerConfig, kind: BindingKind): Record<string, unknown>[] {
  let value: unknown = section
  for (const key of kind.path ?? [kind.type]) value = record(value)?.[key]
  if (kind.single) { const entry = record(value); return entry ? [entry] : [] }
  return Array.isArray(value) ? value.map(record).filter((entry): entry is Record<string, unknown> => entry !== null) : []
}

/** Binding names, kinds and resource names declared in one configuration section. Values of `vars` are never included. */
export function configBindings(section: WranglerConfig): CloudflareBinding[] {
  const bindings: CloudflareBinding[] = []
  for (const kind of BINDING_KINDS) {
    for (const entry of bindingEntries(section, kind)) {
      const name = stringValue(entry[kind.name ?? "binding"])
      if (!name) continue
      bindings.push({ name, type: kind.type, target: kind.target ? nullableString(entry[kind.target]) : null })
    }
  }
  const vars = record(section.vars)
  if (vars) for (const name of Object.keys(vars)) bindings.push({ name, type: "vars", target: null })
  return bindings
}

function routePatterns(section: WranglerConfig): string[] {
  const values = [...(Array.isArray(section.routes) ? section.routes : []), section.route]
  return values.map(value => typeof value === "string" ? value : stringValue(record(value)?.pattern)).filter(Boolean)
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : []
}

function crons(section: WranglerConfig): string[] | null {
  const triggers = record(section.triggers)
  return triggers && "crons" in triggers ? stringList(triggers.crons) : null
}

/**
 * Environments as Wrangler resolves them: `name`, `routes` and `triggers` are
 * inherited from the top level while bindings and `vars` are not.
 */
export type DeclaredEnvironment = Omit<CloudflareEnvironment, "dashboardUrl">

export function configEnvironments(config: WranglerConfig, workerName: string): DeclaredEnvironment[] {
  const top: DeclaredEnvironment = { name: null, workerName, routes: routePatterns(config), crons: crons(config) ?? [], bindings: configBindings(config), compatibilityDate: nullableString(config.compatibility_date) }
  const declared = record(config.env) ?? {}
  const environments = Object.keys(declared).filter(name => ENVIRONMENT_NAME.test(name)).sort().map((name): DeclaredEnvironment => {
    const section = record(declared[name]) ?? {}
    const routes = "routes" in section || "route" in section ? routePatterns(section) : top.routes
    return { name, workerName: stringValue(section.name) || `${workerName}-${name}`, routes, crons: crons(section) ?? top.crons, bindings: configBindings(section), compatibilityDate: nullableString(section.compatibility_date) ?? top.compatibilityDate }
  })
  return [top, ...environments]
}

export function describeConfig(project: WranglerProject): { workerName: string; environments: DeclaredEnvironment[] } {
  if (typeof project.config.pages_build_output_dir === "string") {
    throw new CloudflareRouteError(400, "cloudflare_pages_unsupported", "This configuration describes a Cloudflare Pages project; only Workers are supported")
  }
  const workerName = stringValue(project.config.name)
  if (!workerName) throw invalidConfig("Set a Worker name in the Wrangler configuration to view deployments")
  return { workerName, environments: configEnvironments(project.config, workerName) }
}

async function authorize(context: PluginIntegrationContext): Promise<void> {
  context.signal.throwIfAborted()
  await context.authorize()
  context.signal.throwIfAborted()
}

/** Prefer the project's own Wrangler, searching from the configuration directory up to the repository root, before the host PATH. */
export async function findLocalWrangler(project: Pick<WranglerProject, "root" | "repositoryRoot">, platform = process.platform): Promise<string | null> {
  const binary = platform === "win32" ? "wrangler.cmd" : "wrangler"
  let directory = project.root
  while (true) {
    const candidate = join(directory, "node_modules", ".bin", binary)
    try {
      await access(candidate)
      return candidate
    } catch {
      /* Not installed here; keep walking toward the repository root. */
    }
    if (!project.repositoryRoot || directory === project.repositoryRoot) return null
    const parent = dirname(directory)
    if (parent === directory || !isWithinDir(project.repositoryRoot, parent)) return null
    directory = parent
  }
}

export async function executeWrangler(project: WranglerProject, args: string[], context: PluginIntegrationContext): Promise<CommandResult> {
  await authorize(context)
  const cli = resolveAgentCommand((await findLocalWrangler(project)) ?? "wrangler", args)
  const result = await execFile(cli.command, cli.args, {
    cwd: project.root,
    encoding: "utf-8",
    env: { ...process.env, NO_COLOR: "1", WRANGLER_SEND_METRICS: "false" },
    maxBuffer: 16 * 1024 * 1024,
    timeout: 60_000,
    windowsHide: true,
    ...cli.spawnOptions,
    signal: context.signal,
  })
  await authorize(context)
  return { stdout: result.stdout, stderr: result.stderr }
}

function parseCliVersion(output: string): [number, number, number] | null {
  const match = output.match(/(?:^|\s)(\d+)\.(\d+)\.(\d+)(?:\s|$)/)
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null
}

function isVersionAtLeast(actual: readonly number[], minimum: readonly number[]): boolean {
  for (let index = 0; index < minimum.length; index += 1) {
    if (actual[index] > minimum[index]) return true
    if (actual[index] < minimum[index]) return false
  }
  return true
}

export function mapWranglerFailure(error: unknown): CloudflareRouteError {
  if (error instanceof CloudflareRouteError) return error
  const failure = error as NodeJS.ErrnoException & { stderr?: string; stdout?: string }
  if (failure.code === "ENOENT") {
    return new CloudflareRouteError(503, "wrangler_missing", "Install Wrangler in this project or on the Cogpit host to view deployments")
  }
  const detail = `${failure.message ?? ""}\n${failure.stderr ?? ""}\n${failure.stdout ?? ""}`
  if (/Unknown argument: json/i.test(detail)) return unsupportedCli()
  if (/"loggedIn":\s*false|not authenticated|not logged in|wrangler login|Authentication (error|failed)|Unable to authenticate|code: (10000|9106|10001)\]|invalid.*token|CLOUDFLARE_API_TOKEN/i.test(detail)) {
    return new CloudflareRouteError(503, "cloudflare_auth_required", "Sign in with `wrangler login` on the Cogpit host, or set CLOUDFLARE_API_TOKEN, to view deployments")
  }
  if (/code: 10007\]|does not exist on your account|(worker|script) not found/i.test(detail)) {
    return new CloudflareRouteError(404, "cloudflare_worker_missing", "This Worker has not been deployed to the selected Cloudflare account yet")
  }
  if (/more than one account|which account|account_id|CLOUDFLARE_ACCOUNT_ID/i.test(detail)) {
    return new CloudflareRouteError(400, "cloudflare_account_required", "Set account_id in the Wrangler configuration or CLOUDFLARE_ACCOUNT_ID on the Cogpit host")
  }
  if (/forbidden|not authorized|access denied|permission|code: (10021|10013)\]|\b403\b/i.test(detail)) {
    return new CloudflareRouteError(403, "cloudflare_access_denied", "Your Cloudflare account cannot access this Worker")
  }
  return new CloudflareRouteError(502, "cloudflare_api_failed", "Cloudflare deployment data is unavailable")
}

function parseJsonOutput(stdout: string): unknown {
  const start = stdout.search(/[[{]/)
  try {
    return JSON.parse(start === -1 ? stdout : stdout.slice(start)) as unknown
  } catch {
    throw new CloudflareRouteError(502, "invalid_response", "Wrangler returned invalid JSON")
  }
}

/** Wrangler cold-starts slowly, so a passed version probe is remembered per runner and project for a while. */
const VERSION_PROBE_TTL_MS = 10 * 60_000
const probedVersions = new WeakMap<WranglerCommandRunner, Map<string, number>>()

async function ensureSupportedVersion(project: WranglerProject, context: PluginIntegrationContext, runCommand: WranglerCommandRunner): Promise<void> {
  let probed = probedVersions.get(runCommand)
  if (!probed) { probed = new Map(); probedVersions.set(runCommand, probed) }
  const checkedAt = probed.get(project.root)
  if (checkedAt !== undefined && Date.now() - checkedAt < VERSION_PROBE_TTL_MS) return
  const versionResult = await runCommand(project, ["--version"], context)
  await authorize(context)
  const version = parseCliVersion(`${versionResult.stdout}\n${versionResult.stderr}`)
  if (!version || !isVersionAtLeast(version, MINIMUM_CLI_VERSION)) throw unsupportedCli()
  probed.set(project.root, Date.now())
}

export async function runWrangler(project: WranglerProject, args: string[], context: PluginIntegrationContext, runCommand: WranglerCommandRunner = executeWrangler): Promise<unknown> {
  await authorize(context)
  try {
    await ensureSupportedVersion(project, context, runCommand)
    const result = await runCommand(project, [...args, "--config", project.configPath], context)
    await authorize(context)
    return parseJsonOutput(result.stdout)
  } catch (error) {
    await authorize(context)
    throw mapWranglerFailure(error)
  }
}

function isoTimestamp(value: unknown): string | null {
  const text = stringValue(value)
  return text && Number.isFinite(Date.parse(text)) ? text : null
}

function annotation(source: Record<string, unknown>, key: string): string | null {
  return nullableString(record(source.annotations)?.[`workers/${key}`])
}

function parseDeployment(value: unknown): CloudflareDeployment | null {
  const source = record(value)
  const id = stringValue(source?.id)
  const createdAt = isoTimestamp(source?.created_on)
  if (!source || !id || !createdAt) return null
  const versions = (Array.isArray(source.versions) ? source.versions : []).flatMap(entry => {
    const version = record(entry)
    const versionId = stringValue(version?.version_id)
    const percentage = typeof version?.percentage === "number" && Number.isFinite(version.percentage) ? version.percentage : 100
    return VERSION_ID.test(versionId) ? [{ id: versionId, percentage }] : []
  })
  return {
    id,
    createdAt,
    source: stringValue(source.source, "unknown"),
    strategy: stringValue(source.strategy, "percentage"),
    author: stringValue(source.author_email),
    message: annotation(source, "message"),
    triggeredBy: annotation(source, "triggered_by"),
    versions,
  }
}

export function parseDeploymentsOutput(value: unknown): CloudflareDeployment[] {
  if (!Array.isArray(value)) throw new CloudflareRouteError(502, "invalid_response", "Wrangler returned an invalid deployments list")
  return value
    .map(parseDeployment)
    .filter((deployment): deployment is CloudflareDeployment => deployment !== null)
    .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt))
}

export function parseVersionOutput(value: unknown): CloudflareVersion {
  const source = record(value)
  const id = stringValue(source?.id)
  const metadata = record(source?.metadata)
  const createdAt = isoTimestamp(metadata?.created_on)
  if (!source || !VERSION_ID.test(id) || !createdAt) throw new CloudflareRouteError(502, "invalid_response", "Wrangler returned an invalid version")
  const resources = record(source.resources)
  const script = record(resources?.script)
  const runtime = record(resources?.script_runtime)
  const bindings = (Array.isArray(resources?.bindings) ? resources.bindings : []).flatMap(entry => {
    const binding = record(entry)
    const name = stringValue(binding?.name), type = stringValue(binding?.type)
    return name && type ? [{ name, type }] : []
  })
  return {
    id,
    number: typeof source.number === "number" && Number.isSafeInteger(source.number) ? source.number : null,
    createdAt,
    source: stringValue(metadata?.source, "unknown"),
    author: stringValue(metadata?.author_email),
    message: annotation(source, "message"),
    tag: annotation(source, "tag"),
    triggeredBy: annotation(source, "triggered_by"),
    hasPreview: metadata?.has_preview === true,
    compatibilityDate: nullableString(runtime?.compatibility_date),
    compatibilityFlags: stringList(runtime?.compatibility_flags),
    handlers: stringList(script?.handlers),
    usageModel: nullableString(runtime?.usage_model),
    bindings,
  }
}

function environmentArgs(environment: string | null): string[] {
  return environment ? ["--env", environment] : []
}

function selectEnvironment(environments: DeclaredEnvironment[], name: string | undefined): DeclaredEnvironment {
  const environment = environments.find(entry => entry.name === (name ?? null))
  if (!environment) throw invalidConfig(`Environment ${name} is not declared in the Wrangler configuration`)
  return environment
}

const defaultDependencies: CloudflareDependencies = {
  resolveProjects: discoverWranglerProjects,
  wrangler: (project, args, context) => runWrangler(project, args, context),
}

async function describeWorkspace(project: WranglerProject, configs: string[], call: (args: string[]) => Promise<unknown>, cliEnvironment: NodeJS.ProcessEnv): Promise<CloudflareWorkspace> {
  const described = describeConfig(project)
  const identity = record(await call(["whoami", "--json"]))
  if (identity?.loggedIn !== true) throw mapWranglerFailure({ stdout: "\"loggedIn\": false" })
  const accounts = (Array.isArray(identity.accounts) ? identity.accounts : []).flatMap(entry => {
    const account = record(entry)
    const id = stringValue(account?.id)
    return ACCOUNT_ID.test(id) ? [{ id, name: stringValue(account?.name, id) }] : []
  })
  const configuredId = stringValue(project.config.account_id) || stringValue(cliEnvironment.CLOUDFLARE_ACCOUNT_ID)
  const account = configuredId
    ? accounts.find(entry => entry.id === configuredId) ?? (ACCOUNT_ID.test(configuredId) ? { id: configuredId, name: configuredId } : null)
    : accounts.length === 1 ? accounts[0] : null
  return {
    workerName: described.workerName,
    configPath: project.key,
    configs,
    environments: described.environments.map(environment => ({
      ...environment,
      dashboardUrl: account ? `https://dash.cloudflare.com/${account.id}/workers/services/view/${encodeURIComponent(environment.workerName)}/production` : null,
    })),
    email: nullableString(identity.email),
    account,
  }
}

export async function executeCloudflareIntegration(
  input: CloudflareIntegrationRequest,
  context: PluginIntegrationContext,
  dependencies: CloudflareDependencies = defaultDependencies,
): Promise<CloudflareWorkspace | CloudflareDeploymentsResponse | CloudflareVersionResponse> {
  await authorize(context)
  if (input.operation === "version" && !VERSION_ID.test(input.versionId)) {
    throw new CloudflareRouteError(400, "cloudflare_api_failed", "versionId must be a Cloudflare version ID")
  }
  const projects = await dependencies.resolveProjects(context.workspacePath, context.signal)
  const project = selectWranglerProject(projects, input.config)
  await authorize(context)
  const call = async (args: string[]) => {
    await authorize(context)
    const value = await dependencies.wrangler(project, args, context)
    await authorize(context)
    return value
  }
  if (input.operation === "workspace") return describeWorkspace(project, projects.map(entry => entry.key), call, dependencies.environment ?? process.env)
  const environment = selectEnvironment(describeConfig(project).environments, input.environment)
  if (input.operation === "deployments") {
    const limit = Math.min(MAX_DEPLOYMENT_LIMIT, Math.max(1, input.limit ?? DEFAULT_DEPLOYMENT_LIMIT))
    const deployments = parseDeploymentsOutput(await call(["deployments", "list", "--json", ...environmentArgs(environment.name)])).slice(0, limit)
    return { workerName: environment.workerName, environment: environment.name, deployments }
  }
  const version = parseVersionOutput(await call(["versions", "view", input.versionId, "--json", ...environmentArgs(environment.name)]))
  if (version.id !== input.versionId) throw new CloudflareRouteError(502, "invalid_response", "Wrangler returned a different version")
  return { version }
}
