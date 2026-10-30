import { z } from "zod"
import { CONTRACT_LIMITS, type JsonValue } from "./json.js"
import { parseSchema } from "./schema.js"

const githubOperations = ["actions", "actionJobs", "pulls", "pullFiles", "pullSessions", "issues", "mergePull", "pullReview", "submitReview", "reviewGuide", "cancelReviewGuide"] as const
const vercelOperations = ["deployments", "buildLogs"] as const
const cloudflareOperations = ["workspace", "deployments", "version"] as const
const worktreeSetupOperations = ["snapshot", "scripts", "propose", "act"] as const
const operations = <T extends readonly [string, ...string[]]>(values: T) => z.array(z.enum(values)).min(1).max(values.length).refine(list => new Set(list).size === list.length, "Duplicate operation")
export const integrationPermissionSchema = z.discriminatedUnion("id", [
  z.strictObject({ id: z.literal("github"), operations: operations(githubOperations) }),
  z.strictObject({ id: z.literal("vercel"), operations: operations(vercelOperations) }),
  z.strictObject({ id: z.literal("cloudflare"), operations: operations(cloudflareOperations) }),
  /** Release-owned: the host grants it only to the exact package bundled with this Cogpit release. */
  z.strictObject({ id: z.literal("worktreeSetup"), operations: operations(worktreeSetupOperations) }),
])
const positive = z.number().int().positive().max(Number.MAX_SAFE_INTEGER)
const github = { integration: z.literal("github") }
const sha = z.string().regex(/^[0-9a-f]{40}$/)
/** Limits of one explicit review submission; its request is the one GitHub request larger than `argumentBytes`. */
export const REVIEW_LIMITS = Object.freeze({ comments: 50, commentBytes: 8192, bodyBytes: 16384, submissionBytes: 60000, pathChars: 1024 })
const reviewText = (maxBytes: number) => z.string().refine((value) => new TextEncoder().encode(value).byteLength <= maxBytes, "Text exceeds byte limit")
const reviewComment = z.strictObject({
  path: z.string().min(1).max(REVIEW_LIMITS.pathChars),
  side: z.enum(["LEFT", "RIGHT"]),
  line: positive,
  body: reviewText(REVIEW_LIMITS.commentBytes).refine((value) => value.trim().length > 0, "Comment is empty"),
})
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
  z.strictObject({ ...github, operation: z.literal("mergePull"), number: positive, method: z.enum(["merge", "squash", "rebase"]), headSha: sha }),
  z.strictObject({ ...github, operation: z.literal("pullReview"), number: positive, page: positive.max(30).optional() }),
  z.strictObject({
    ...github, operation: z.literal("submitReview"), number: positive, headSha: sha, baseSha: sha,
    submissionId: z.string().regex(/^[a-zA-Z0-9_-]{8,64}$/), body: reviewText(REVIEW_LIMITS.bodyBytes),
    comments: z.array(reviewComment).max(REVIEW_LIMITS.comments),
  }).refine((value) => value.comments.length > 0 || value.body.trim().length > 0, "A review needs a comment or a summary"),
  z.strictObject({ ...github, operation: z.literal("reviewGuide"), number: positive }),
  z.strictObject({ ...github, operation: z.literal("cancelReviewGuide"), number: positive }),
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
const worktreeSetup = { integration: z.literal("worktreeSetup") }
/** The longest setup command a recipe may hold. */
export const WORKTREE_SETUP_COMMAND_BYTES = 8000
const worktreeSetupRequestSchema = z.discriminatedUnion("operation", [
  z.strictObject({ ...worktreeSetup, operation: z.literal("snapshot") }),
  /** Scripts the workspace's root package declares, offered to fill the command field; never run on their own. */
  z.strictObject({ ...worktreeSetup, operation: z.literal("scripts") }),
  /** Proposes a recipe; Cogpit shows the exact command in its own dialog and saves it only on the user's confirmation. An empty command disables setup. */
  z.strictObject({
    ...worktreeSetup, operation: z.literal("propose"),
    command: z.string().max(WORKTREE_SETUP_COMMAND_BYTES).refine((value) => !value.includes("\0") && new TextEncoder().encode(value).byteLength <= WORKTREE_SETUP_COMMAND_BYTES, "Invalid setup command"),
    timeoutMs: z.number().int().min(1000).max(60 * 60_000),
  }),
  z.strictObject({ ...worktreeSetup, operation: z.literal("act"), operationId: z.string().uuid(), action: z.enum(["retry", "cancel"]) }),
])
export const integrationRequestSchema = z.discriminatedUnion("integration", [githubRequestSchema, vercelRequestSchema, cloudflareRequestSchema, worktreeSetupRequestSchema])
export type PluginIntegrationRequest = z.infer<typeof integrationRequestSchema>
export type GitHubIntegrationRequest = Extract<PluginIntegrationRequest, { integration: "github" }>
export type VercelIntegrationRequest = Extract<PluginIntegrationRequest, { integration: "vercel" }>
export type CloudflareIntegrationRequest = Extract<PluginIntegrationRequest, { integration: "cloudflare" }>
export type WorktreeSetupIntegrationRequest = Extract<PluginIntegrationRequest, { integration: "worktreeSetup" }>
export const integrationResultSchema = z.discriminatedUnion("ok", [
  z.strictObject({ ok: z.literal(true), data: z.custom<JsonValue>(() => true) }),
  z.strictObject({ ok: z.literal(false), error: z.strictObject({ code: z.string().min(1).max(64), message: z.string().min(1).max(512) }) }),
])
export type PluginIntegrationResult = z.infer<typeof integrationResultSchema>
/** The byte budget of an integration request's parameters. */
export function integrationRequestBytes(value: unknown): number {
  const fields = value !== null && typeof value === "object" ? value as Record<string, unknown> : {}
  if (fields.integration === "worktreeSetup" && fields.operation === "propose") return WORKTREE_SETUP_COMMAND_BYTES * 6 + 256
  return fields.integration === "github" && fields.operation === "submitReview" ? REVIEW_LIMITS.submissionBytes : CONTRACT_LIMITS.argumentBytes
}
export function parseIntegrationRequest(value: unknown): PluginIntegrationRequest {
  return parseSchema(integrationRequestSchema, value, integrationRequestBytes(value))
}
