import type { VercelIntegrationRequest } from "@cogpit/plugin-contracts"
import type { PluginIntegrationContext } from "../integrationTypes"
import { execFile as execFileCallback } from "node:child_process"
import { readFile, stat } from "node:fs/promises"
import { join } from "node:path"
import { promisify } from "node:util"
import type {
  VercelBuildLog,
  VercelBuildLogsResponse,
  VercelDeployment,
  VercelDeploymentsErrorCode,
  VercelDeploymentsResponse,
  VercelDeploymentState,
} from "@cogpit/plugin-integrations"
import { resolveAgentCommand } from "../../lib/binaryResolver"
import { canonicalDirectory, findNearestProjectRoot } from "../../lib/projectRoot"
import { nullableString, record, stringValue } from "../../routes/apiValues"

const execFile = promisify(execFileCallback)
const DEFAULT_DEPLOYMENT_LIMIT = 20
const MAX_DEPLOYMENT_LIMIT = 30
const DEFAULT_LOG_LIMIT = 200
const MAX_LOG_LIMIT = 500
const MAX_PROJECT_FILE_BYTES = 64 * 1024
const MINIMUM_API_CLI_VERSION = [50, 5, 1] as const
const VERCEL_ID = /^[A-Za-z0-9_-]+$/
const DEPLOYMENT_ID = /^dpl_[A-Za-z0-9]+$/
const DEPLOYMENT_STATES = new Set<VercelDeploymentState>([
  "BLOCKED",
  "BUILDING",
  "CANCELED",
  "ERROR",
  "INITIALIZING",
  "QUEUED",
  "READY",
])

export interface LinkedVercelProject {
  root: string
  projectId: string
  projectName: string
  teamId: string
}

interface VercelCommandResult {
  stdout: string
  stderr: string
}

export type VercelCommandRunner = (
  cwd: string,
  args: string[],
  context: PluginIntegrationContext,
) => Promise<VercelCommandResult>

export interface VercelDeploymentDependencies {
  resolveProject: (cwd: string, signal?: AbortSignal) => Promise<LinkedVercelProject>
  vercelApi: (project: LinkedVercelProject, endpoint: string, context: PluginIntegrationContext) => Promise<unknown>
}

export class VercelDeploymentsRouteError extends Error {
  constructor(
    readonly status: number,
    readonly code: VercelDeploymentsErrorCode,
    message: string,
  ) {
    super(message)
  }
}

function timestamp(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : null
}

function firstString(source: Record<string, unknown> | null, keys: string[]): string {
  if (!source) return ""
  for (const key of keys) {
    const value = stringValue(source[key])
    if (value) return value
  }
  return ""
}

function deploymentState(value: unknown): VercelDeploymentState {
  return typeof value === "string" && DEPLOYMENT_STATES.has(value as VercelDeploymentState)
    ? value as VercelDeploymentState
    : "QUEUED"
}

function httpsUrl(value: unknown, hostnameOnly = false): string | null {
  const text = stringValue(value)
  if (!text) return null
  const candidate = hostnameOnly && !text.includes("://") ? `https://${text}` : text
  try {
    const url = new URL(candidate)
    return url.protocol === "https:" ? url.toString().replace(/\/$/, "") : null
  } catch {
    return null
  }
}

function projectUrlFromInspector(value: string | null): string | null {
  if (!value) return null
  try {
    const url = new URL(value)
    const parts = url.pathname.split("/").filter(Boolean)
    if (parts.length < 3) return null
    url.pathname = `/${parts.slice(0, -1).join("/")}`
    url.search = ""
    url.hash = ""
    return url.toString().replace(/\/$/, "")
  } catch {
    return null
  }
}

function parseDeployment(value: unknown): VercelDeployment | null {
  const source = record(value)
  if (!source) return null
  const id = stringValue(source.uid)
  const createdAt = timestamp(source.createdAt) ?? timestamp(source.created)
  if (!DEPLOYMENT_ID.test(id) || createdAt === null) return null
  const meta = record(source.meta)
  const creator = record(source.creator)

  return {
    id,
    name: stringValue(source.name, "Deployment"),
    url: httpsUrl(source.url, true),
    inspectorUrl: httpsUrl(source.inspectorUrl),
    state: deploymentState(source.readyState ?? source.state),
    target: nullableString(source.target),
    createdAt,
    buildingAt: timestamp(source.buildingAt),
    readyAt: timestamp(source.ready),
    branch: firstString(meta, [
      "githubCommitRef",
      "gitlabCommitRef",
      "bitbucketCommitRef",
      "branchAlias",
    ]),
    commitSha: firstString(meta, [
      "githubCommitSha",
      "gitlabCommitSha",
      "bitbucketCommitSha",
    ]),
    commitMessage: firstString(meta, [
      "githubCommitMessage",
      "gitlabCommitMessage",
      "bitbucketCommitMessage",
    ]),
    creator: firstString(creator, ["username", "githubLogin", "email"]),
    errorCode: nullableString(source.errorCode),
    errorMessage: nullableString(source.errorMessage),
  }
}

export function parseDeploymentsResponse(value: unknown): VercelDeployment[] {
  const source = record(value)
  if (!source || !Array.isArray(source.deployments)) {
    throw new VercelDeploymentsRouteError(
      502,
      "invalid_response",
      "Vercel returned an invalid deployments response",
    )
  }
  return source.deployments
    .map(parseDeployment)
    .filter((deployment): deployment is VercelDeployment => deployment !== null)
}

function parseBuildLog(value: unknown): VercelBuildLog | null {
  const source = record(value)
  if (!source) return null
  const createdAt = timestamp(source.created) ?? timestamp(source.date)
  const text = stringValue(source.text)
  if (createdAt === null || !text) return null
  return {
    id: stringValue(source.id, `${createdAt}-${text}`),
    createdAt,
    type: stringValue(source.type, "stdout"),
    text,
  }
}

export function parseBuildLogsResponse(value: unknown): VercelBuildLog[] {
  if (!Array.isArray(value)) {
    throw new VercelDeploymentsRouteError(
      502,
      "invalid_response",
      "Vercel returned an invalid build log response",
    )
  }
  return value
    .map(parseBuildLog)
    .filter((event): event is VercelBuildLog => event !== null)
    .sort((left, right) => left.createdAt - right.createdAt)
}

function parseProjectFile(value: unknown, root: string): LinkedVercelProject {
  const source = record(value)
  const projectId = stringValue(source?.projectId)
  const teamId = stringValue(source?.orgId)
  const projectName = stringValue(source?.projectName, "Vercel project")
  if (!VERCEL_ID.test(projectId) || !VERCEL_ID.test(teamId)) {
    throw new VercelDeploymentsRouteError(
      400,
      "vercel_project_unlinked",
      "This project has an invalid .vercel/project.json link",
    )
  }
  return { root, projectId, projectName, teamId }
}

export async function resolveLinkedVercelProject(cwd: string, signal?: AbortSignal): Promise<LinkedVercelProject> {
  signal?.throwIfAborted()
  const root = await canonicalDirectory(cwd)
  if (!root) {
    throw new VercelDeploymentsRouteError(404, "vercel_project_unlinked", "Project directory not found")
  }
  const linked = await findNearestProjectRoot(root, readLinkedVercelProject, signal)
  if (linked) return linked.value
  throw new VercelDeploymentsRouteError(
    400,
    "vercel_project_unlinked",
    "Link this workspace or its repository root with `vercel link` before viewing deployments",
  )
}

async function readLinkedVercelProject(root: string): Promise<LinkedVercelProject | null> {
  const projectFile = join(root, ".vercel", "project.json")
  try {
    const info = await stat(projectFile)
    if (!info.isFile() || info.size > MAX_PROJECT_FILE_BYTES) throw new Error("invalid project file")
    return parseProjectFile(JSON.parse(await readFile(projectFile, "utf8")) as unknown, root)
  } catch (error) {
    if (error instanceof VercelDeploymentsRouteError) throw error
    const detail = error as NodeJS.ErrnoException
    if (detail.code === "ENOENT") {
      return null
    }
    throw new VercelDeploymentsRouteError(
      400,
      "vercel_project_unlinked",
      "Unable to read this project's .vercel/project.json link",
    )
  }
}

async function authorize(context: PluginIntegrationContext): Promise<void> {
  context.signal.throwIfAborted()
  await context.authorize()
  context.signal.throwIfAborted()
}

export async function executeVercel(cwd: string, args: string[], context: PluginIntegrationContext): Promise<VercelCommandResult> {
  await authorize(context)
  const cli = resolveAgentCommand("vercel", args)
  const result = await execFile(cli.command, cli.args, {
    cwd,
    encoding: "utf-8",
    env: {
      ...process.env,
      NO_COLOR: "1",
      VERCEL_TELEMETRY_DISABLED: "1",
    },
    maxBuffer: 16 * 1024 * 1024,
    timeout: 30_000,
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

function isVersionAtLeast(
  actual: readonly number[],
  minimum: readonly number[],
): boolean {
  for (let index = 0; index < minimum.length; index += 1) {
    if (actual[index] > minimum[index]) return true
    if (actual[index] < minimum[index]) return false
  }
  return true
}

export function mapVercelFailure(error: unknown): VercelDeploymentsRouteError {
  if (error instanceof VercelDeploymentsRouteError) return error
  const failure = error as NodeJS.ErrnoException & { stderr?: string; stdout?: string }
  if (failure.code === "ENOENT") {
    return new VercelDeploymentsRouteError(503, "vercel_missing", "Install Vercel CLI to view deployments")
  }
  const detail = `${failure.message ?? ""}\n${failure.stderr ?? ""}\n${failure.stdout ?? ""}`
  if (/not authenticated|not logged|log in|login|authentication|invalid token|unauthorized|401/i.test(detail)) {
    return new VercelDeploymentsRouteError(
      503,
      "vercel_auth_required",
      "Sign in with `vercel login` to view deployments",
    )
  }
  if (/forbidden|access denied|not authorized|permission|403/i.test(detail)) {
    return new VercelDeploymentsRouteError(
      403,
      "vercel_access_denied",
      "Your Vercel account cannot access this linked project",
    )
  }
  return new VercelDeploymentsRouteError(502, "vercel_api_failed", "Vercel deployment data is unavailable")
}

export async function runVercelApi(
  project: LinkedVercelProject,
  endpoint: string,
  context: PluginIntegrationContext,
  runCommand: VercelCommandRunner = executeVercel,
): Promise<unknown> {
  await authorize(context)
  try {
    const versionResult = await runCommand(project.root, ["--version"], context)
    await authorize(context)
    const version = parseCliVersion(`${versionResult.stdout}\n${versionResult.stderr}`)
    if (!version || !isVersionAtLeast(version, MINIMUM_API_CLI_VERSION)) {
      throw new VercelDeploymentsRouteError(
        503,
        "vercel_cli_too_old",
        "Update Vercel CLI to version 50.5.1 or newer to view deployments safely",
      )
    }

    const result = await runCommand(project.root, [
      "api",
      endpoint,
      "--raw",
      "--cwd",
      project.root,
      "--non-interactive",
      "--no-color",
    ], context)
    await authorize(context)
    try {
      return JSON.parse(result.stdout) as unknown
    } catch {
      throw new VercelDeploymentsRouteError(
        502,
        "invalid_response",
        "Vercel returned invalid JSON",
      )
    }
  } catch (error) {
    await authorize(context)
    throw mapVercelFailure(error)
  }
}

const defaultDependencies: VercelDeploymentDependencies = {
  resolveProject: resolveLinkedVercelProject,
  vercelApi: (project, endpoint, context) => runVercelApi(project, endpoint, context),
}

export async function executeVercelIntegration(
  input: VercelIntegrationRequest,
  context: PluginIntegrationContext,
  dependencies: VercelDeploymentDependencies = defaultDependencies,
): Promise<VercelDeploymentsResponse | VercelBuildLogsResponse> {
  await authorize(context)
  if (input.operation === "buildLogs" && !DEPLOYMENT_ID.test(input.deploymentId)) {
    throw new VercelDeploymentsRouteError(400, "vercel_api_failed", "deploymentId must be a Vercel deployment ID")
  }
  const project = await dependencies.resolveProject(context.workspacePath, context.signal)
  await authorize(context)
  const call = async (endpoint: string) => {
    await authorize(context)
    const value = await dependencies.vercelApi(project, endpoint, context)
    await authorize(context)
    return value
  }
  if (input.operation === "deployments") {
    const limit = Math.min(MAX_DEPLOYMENT_LIMIT, Math.max(1, input.limit ?? DEFAULT_DEPLOYMENT_LIMIT))
    const deployments = parseDeploymentsResponse(await call(`/v7/deployments?projectId=${encodeURIComponent(project.projectId)}&teamId=${encodeURIComponent(project.teamId)}&limit=${limit}`)).slice(0, limit)
    return { projectId: project.projectId, projectName: project.projectName, teamId: project.teamId, projectUrl: projectUrlFromInspector(deployments[0]?.inspectorUrl ?? null), deployments }
  }
  const deployment = record(await call(`/v13/deployments/${input.deploymentId}?teamId=${encodeURIComponent(project.teamId)}`))
  const projectIds = [deployment?.projectId, record(deployment?.project)?.id].filter(id => id !== undefined)
  if (deployment?.id !== input.deploymentId || !projectIds.length || projectIds.some(id => id !== project.projectId)) {
    throw new VercelDeploymentsRouteError(403, "vercel_access_denied", "This deployment does not belong to the linked Vercel project")
  }
  const limit = Math.min(MAX_LOG_LIMIT, Math.max(1, input.limit ?? DEFAULT_LOG_LIMIT))
  const events = parseBuildLogsResponse(await call(`/v3/deployments/${input.deploymentId}/events?teamId=${encodeURIComponent(project.teamId)}&direction=backward&limit=${limit}`)).slice(-limit)
  return { deploymentId: input.deploymentId, events }
}
