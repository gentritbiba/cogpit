import { z } from "zod"
import { CONTRACT_LIMITS, type JsonValue } from "./json.js"
import { parseSchema } from "./schema.js"

const githubOperations = ["actions", "actionJobs", "pulls", "pullFiles", "pullSessions", "issues", "mergePull"] as const
const vercelOperations = ["deployments", "buildLogs"] as const
const cloudflareOperations = ["workspace", "deployments", "version"] as const
const operations = <T extends readonly [string, ...string[]]>(values: T) => z.array(z.enum(values)).min(1).max(values.length).refine(list => new Set(list).size === list.length, "Duplicate operation")
export const integrationPermissionSchema = z.discriminatedUnion("id", [
  z.strictObject({ id: z.literal("github"), operations: operations(githubOperations) }),
  z.strictObject({ id: z.literal("vercel"), operations: operations(vercelOperations) }),
  z.strictObject({ id: z.literal("cloudflare"), operations: operations(cloudflareOperations) }),
])
const positive = z.number().int().positive().max(Number.MAX_SAFE_INTEGER)
const github = { integration: z.literal("github") }
const vercel = { integration: z.literal("vercel") }
const cloudflare = { integration: z.literal("cloudflare") }
const cloudflareEnvironment = z.string().regex(/^[A-Za-z0-9_-]+$/).max(64).optional()
const cloudflareConfig = z.string().max(240).regex(/^(?:[^/\\]+\/)*wrangler\.(?:json|jsonc|toml)$/).refine(value => value.split("/").every(segment => segment !== "." && segment !== ".."), "Invalid configuration path").optional()
const githubRequestSchema = z.discriminatedUnion("operation", [
  z.strictObject({ ...github, operation: z.literal("actions"), limit: positive.max(30).optional() }),
  z.strictObject({ ...github, operation: z.literal("actionJobs"), runId: positive }),
  z.strictObject({ ...github, operation: z.literal("pulls"), limit: positive.max(50).optional() }),
  z.strictObject({ ...github, operation: z.literal("pullFiles"), number: positive }),
  z.strictObject({ ...github, operation: z.literal("pullSessions") }),
  z.strictObject({ ...github, operation: z.literal("issues"), limit: positive.max(50).optional() }),
  z.strictObject({ ...github, operation: z.literal("mergePull"), number: positive, method: z.enum(["merge", "squash", "rebase"]), headSha: z.string().regex(/^[0-9a-f]{40}$/) }),
])
const vercelRequestSchema = z.discriminatedUnion("operation", [
  z.strictObject({ ...vercel, operation: z.literal("deployments"), limit: positive.max(30).optional() }),
  z.strictObject({ ...vercel, operation: z.literal("buildLogs"), deploymentId: z.string().regex(/^dpl_[A-Za-z0-9]+$/).max(128), limit: positive.max(500).optional() }),
])
const cloudflareRequestSchema = z.discriminatedUnion("operation", [
  z.strictObject({ ...cloudflare, operation: z.literal("workspace"), config: cloudflareConfig }),
  z.strictObject({ ...cloudflare, operation: z.literal("deployments"), config: cloudflareConfig, environment: cloudflareEnvironment, limit: positive.max(30).optional() }),
  z.strictObject({ ...cloudflare, operation: z.literal("version"), config: cloudflareConfig, environment: cloudflareEnvironment, versionId: z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/) }),
])
export const integrationRequestSchema = z.discriminatedUnion("integration", [githubRequestSchema, vercelRequestSchema, cloudflareRequestSchema])
export type PluginIntegrationRequest = z.infer<typeof integrationRequestSchema>
export type GitHubIntegrationRequest = Extract<PluginIntegrationRequest, { integration: "github" }>
export type VercelIntegrationRequest = Extract<PluginIntegrationRequest, { integration: "vercel" }>
export type CloudflareIntegrationRequest = Extract<PluginIntegrationRequest, { integration: "cloudflare" }>
export const integrationResultSchema = z.discriminatedUnion("ok", [
  z.strictObject({ ok: z.literal(true), data: z.custom<JsonValue>(() => true) }),
  z.strictObject({ ok: z.literal(false), error: z.strictObject({ code: z.string().min(1).max(64), message: z.string().min(1).max(512) }) }),
])
export type PluginIntegrationResult = z.infer<typeof integrationResultSchema>
export function parseIntegrationRequest(value: unknown): PluginIntegrationRequest {
  return parseSchema(integrationRequestSchema, value, CONTRACT_LIMITS.argumentBytes)
}
