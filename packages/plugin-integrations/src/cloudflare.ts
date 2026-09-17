export interface CloudflareAccount {
  id: string
  name: string
}

export interface CloudflareBinding {
  /** Variable name the Worker sees, for example `DB` or `SESSIONS`. */
  name: string
  /** Wrangler binding kind, for example `d1_databases` or `kv_namespaces`. */
  type: string
  /** Resource the binding points at when the configuration names one: bucket, database, class or queue name. Never a value or secret. */
  target: string | null
}

export interface CloudflareEnvironment {
  /** Wrangler environment name; `null` is the top-level configuration. */
  name: string | null
  /** Deployed Worker name for this environment, after Wrangler's `<name>-<env>` rule. */
  workerName: string
  routes: string[]
  crons: string[]
  bindings: CloudflareBinding[]
  compatibilityDate: string | null
  /** Dashboard page for this environment's Worker when the account is known. */
  dashboardUrl: string | null
}

export interface CloudflareWorkspace {
  workerName: string
  /** Selected configuration file, relative to the repository root or the workspace: `wrangler.jsonc` or `apps/api/wrangler.toml`. */
  configPath: string
  /** Every Wrangler configuration discovered for this workspace, nearest first; pass one as `config` to read another Worker. */
  configs: string[]
  environments: CloudflareEnvironment[]
  /** Signed-in Wrangler identity. */
  email: string | null
  /** The account Wrangler operates on, or `null` when it cannot be determined without a prompt. */
  account: CloudflareAccount | null
}

export interface CloudflareDeploymentVersion {
  id: string
  percentage: number
}

export interface CloudflareDeployment {
  id: string
  createdAt: string
  source: string
  strategy: string
  author: string
  message: string | null
  triggeredBy: string | null
  versions: CloudflareDeploymentVersion[]
}

export interface CloudflareDeploymentsResponse {
  workerName: string
  environment: string | null
  deployments: CloudflareDeployment[]
}

export interface CloudflareVersionBinding {
  name: string
  type: string
}

export interface CloudflareVersion {
  id: string
  number: number | null
  createdAt: string
  source: string
  author: string
  message: string | null
  /** `workers/tag` annotation, usually the deployed commit SHA. */
  tag: string | null
  triggeredBy: string | null
  hasPreview: boolean
  compatibilityDate: string | null
  compatibilityFlags: string[]
  handlers: string[]
  usageModel: string | null
  bindings: CloudflareVersionBinding[]
}

export interface CloudflareVersionResponse {
  version: CloudflareVersion
}

export type CloudflareErrorCode =
  | "invalid_response"
  | "cloudflare_access_denied"
  | "cloudflare_account_required"
  | "cloudflare_api_failed"
  | "cloudflare_auth_required"
  | "cloudflare_config_invalid"
  | "cloudflare_config_missing"
  | "cloudflare_pages_unsupported"
  | "cloudflare_worker_missing"
  | "wrangler_missing"
  | "wrangler_too_old"

export interface CloudflareErrorResponse {
  error: string
  code: CloudflareErrorCode
}

/** One Worker script as listed by the Cloudflare API for the connected account. */
export interface CloudflareAccountWorker {
  name: string
  createdAt: string | null
  modifiedAt: string | null
  handlers: string[]
  usageModel: string | null
  lastDeployedFrom: string | null
  dashboardUrl: string | null
}
