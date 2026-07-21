import { createRequire } from "node:module"
import { query, type ModelInfo, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk"
import type { UseFn } from "../http"
import { resolveClaudeCliPath } from "../sdk-session"
import { codexAppServer } from "../codex-app-server"

/** Option shape consumed by the frontend model dropdowns. */
export interface ModelOption {
  value: string
  label: string
  description?: string
  isDefault?: boolean
  defaultReasoningEffort?: string
  supportedReasoningEfforts?: Array<{
    value: string
    label: string
    description?: string
  }>
  inputModalities?: string[]
  supportsPersonality?: boolean
  serviceTiers?: Array<{
    value: string
    label: string
    description?: string
  }>
  availabilityMessage?: string
  supportsEffort?: boolean
  supportsAdaptiveThinking?: boolean
  supportsAutoMode?: boolean
}

export interface ModelCatalog {
  claude: ModelOption[] | null
  codex: ModelOption[] | null
}

/** Shape of one entry returned by codex app-server `model/list`. */
export interface CodexModel {
  id: string
  model: string
  displayName: string
  description?: string
  hidden?: boolean
  isDefault?: boolean
  defaultReasoningEffort?: string
  supportedReasoningEfforts?: Array<{
    reasoningEffort: string
    description?: string
  }>
  inputModalities?: string[]
  supportsPersonality?: boolean
  additionalSpeedTiers?: string[]
  serviceTiers?: Array<{
    id: string
    name: string
    description?: string
  }>
  availabilityNux?: { message?: string } | null
}

const FETCH_TIMEOUT_MS = 20_000
const CACHE_TTL_MS = 10 * 60 * 1000

/**
 * Map Claude SDK supportedModels() output to dropdown options.
 * The SDK's "default" pseudo-model maps to "" (no --model flag), which is how
 * the UI has always represented "let the CLI pick".
 */
export function mapClaudeModels(models: ModelInfo[]): ModelOption[] | null {
  if (!Array.isArray(models) || models.length === 0) return null
  const options: ModelOption[] = []
  let defaultAlias: ModelOption | undefined
  for (const m of models) {
    if (!m?.value || !m.displayName) continue
    const capabilities: Partial<ModelOption> = {}
    if (typeof m.supportsEffort === "boolean") capabilities.supportsEffort = m.supportsEffort
    if (m.supportedEffortLevels) {
      capabilities.supportedReasoningEfforts = m.supportedEffortLevels.map((effort) => ({
        value: effort,
        label: effortLabel(effort),
      }))
    }
    if (typeof m.supportsAdaptiveThinking === "boolean") {
      capabilities.supportsAdaptiveThinking = m.supportsAdaptiveThinking
    }
    if (typeof m.supportsAutoMode === "boolean") capabilities.supportsAutoMode = m.supportsAutoMode
    if (m.supportsFastMode) {
      capabilities.serviceTiers = [
        { value: "fast", label: "Fast", description: "Lower latency with increased usage" },
      ]
    }
    if (m.value === "default") {
      options.push({ value: "", label: "Default", description: m.description, ...capabilities })
      const family = m.description?.match(/\b(opus|sonnet|haiku|fable)\b/i)?.[1]?.toLowerCase()
      if (family) {
        defaultAlias = {
          value: family,
          label: family.charAt(0).toUpperCase() + family.slice(1),
          description: m.description,
          ...capabilities,
        }
      }
    } else {
      options.push({ value: m.value, label: m.displayName, description: m.description, ...capabilities })
    }
  }
  // The SDK exposes the recommended model only through its "default" pseudo-model.
  // Keep the underlying family selectable so an active session can switch back to
  // it explicitly (for example, Fable -> Opus) without losing live capabilities.
  if (defaultAlias && !options.some((o) => o.value === defaultAlias.value)) {
    const defaultIndex = options.findIndex((o) => o.value === "")
    options.splice(defaultIndex + 1, 0, defaultAlias)
  }
  // Ensure a "" Default entry always exists and comes first
  if (!options.some((o) => o.value === "")) {
    options.unshift({ value: "", label: "Default" })
  } else {
    options.sort((a, b) => (a.value === "" ? -1 : b.value === "" ? 1 : 0))
  }
  return options.length > 1 ? options : null
}

/**
 * Codex display names use dashes throughout ("GPT-5.6-Sol") — match our
 * existing "GPT-5.4 Mini" style by turning only the suffix dashes into spaces.
 */
function prettifyCodexLabel(name: string): string {
  const match = name.match(/^(GPT-[\d.]+)(.*)$/i)
  if (!match) return name
  return match[1] + match[2].replace(/-/g, " ")
}

function effortLabel(effort: string): string {
  switch (effort.toLowerCase()) {
    case "low": return "Light"
    case "xhigh": return "Extra High"
    case "ultra": return "Ultra"
    default: return effort.charAt(0).toUpperCase() + effort.slice(1)
  }
}

function mapCodexModel(model: CodexModel): ModelOption {
  const serviceTiers = Array.isArray(model.serviceTiers)
    ? model.serviceTiers.map((tier) => ({
        value: tier.id,
        label: tier.name,
        description: tier.description,
      }))
    : []

  // Older catalogs advertised speed tiers separately. Preserve that signal so
  // the frontend can still offer Fast mode when it talks to an older CLI.
  for (const tier of model.additionalSpeedTiers ?? []) {
    if (!serviceTiers.some((option) => option.value === tier || option.label.toLowerCase() === tier.toLowerCase())) {
      serviceTiers.push({
        value: tier,
        label: effortLabel(tier),
        description: tier === "fast" ? "Higher throughput with increased usage" : undefined,
      })
    }
  }

  return {
    value: model.model,
    label: prettifyCodexLabel(model.displayName),
    description: model.description,
    isDefault: !!model.isDefault,
    defaultReasoningEffort: model.defaultReasoningEffort,
    supportedReasoningEfforts: (model.supportedReasoningEfforts ?? []).map((effort) => ({
      value: effort.reasoningEffort,
      label: effortLabel(effort.reasoningEffort),
      description: effort.description,
    })),
    inputModalities: model.inputModalities,
    supportsPersonality: model.supportsPersonality,
    serviceTiers,
    availabilityMessage: model.availabilityNux?.message,
    supportsEffort: (model.supportedReasoningEfforts?.length ?? 0) > 0,
  }
}

/** Map codex `model/list` output to dropdown options ("" = codex default). */
export function mapCodexModels(models: CodexModel[]): ModelOption[] | null {
  if (!Array.isArray(models) || models.length === 0) return null
  const visible = models.filter((m) => m && !m.hidden && m.model && m.displayName)
  if (visible.length === 0) return null
  // Default model first, right after the "" Default entry
  visible.sort((a, b) => Number(b.isDefault ?? false) - Number(a.isDefault ?? false))
  const mapped = visible.map(mapCodexModel)
  const providerDefault = mapped.find((model) => model.isDefault) ?? mapped[0]
  return [
    {
      ...providerDefault,
      value: "",
      label: "Default",
      description: providerDefault
        ? `Use Codex's recommended model (${providerDefault.label})`
        : "Use Codex's recommended model",
    },
    ...mapped,
  ]
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolvePromise, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolvePromise(value)
      },
      (err) => {
        clearTimeout(timer)
        reject(err)
      },
    )
  })
}

const CLAUDE_CLI_PATH: string | undefined = resolveClaudeCliPath((id) =>
  createRequire(import.meta.url).resolve(id),
)

/**
 * Ask the Claude Code CLI (via the agent SDK) which models it currently
 * supports. Spawns a short-lived query solely for the supportedModels()
 * control request, then aborts it.
 */
async function fetchClaudeModels(): Promise<ModelOption[] | null> {
  const abort = new AbortController()
  try {
    const q = query({
      // Never-yielding prompt: we only want the control channel.
      // eslint-disable-next-line require-yield
      prompt: (async function* (): AsyncGenerator<SDKUserMessage> {
        await new Promise(() => {})
      })(),
      options: {
        abortController: abort,
        maxTurns: 1,
        pathToClaudeCodeExecutable: CLAUDE_CLI_PATH,
      },
    })
    const models = await withTimeout(q.supportedModels(), FETCH_TIMEOUT_MS, "claude supportedModels")
    return mapClaudeModels(models)
  } catch {
    return null
  } finally {
    abort.abort()
  }
}

/**
 * Ask the shared Codex app-server which models it currently offers. Reusing
 * the product's long-lived transport avoids spawning a second CLI and keeps
 * protocol initialization/capability negotiation in one place.
 */
async function fetchCodexModels(): Promise<ModelOption[] | null> {
  try {
    const result = await withTimeout(
      codexAppServer.call<{ data?: CodexModel[] }>("model/list", { includeHidden: false }),
      FETCH_TIMEOUT_MS,
      "codex model/list",
    )
    return mapCodexModels(result.data ?? [])
  } catch {
    return null
  }
}

// ── Cache ────────────────────────────────────────────────────────────────────

let lastGood: ModelCatalog = { claude: null, codex: null }
let fetchedAt = 0
let inFlight: Promise<ModelCatalog> | null = null

async function getModelCatalog(forceRefresh: boolean): Promise<ModelCatalog> {
  const fresh = Date.now() - fetchedAt < CACHE_TTL_MS
  if (!forceRefresh && fresh && (lastGood.claude || lastGood.codex)) return lastGood
  if (inFlight) return inFlight

  inFlight = (async () => {
    const [claude, codex] = await Promise.all([fetchClaudeModels(), fetchCodexModels()])
    // Keep the previous good list for any side that failed this round
    lastGood = { claude: claude ?? lastGood.claude, codex: codex ?? lastGood.codex }
    fetchedAt = Date.now()
    return lastGood
  })()

  try {
    return await inFlight
  } finally {
    inFlight = null
  }
}

export function registerModelRoutes(use: UseFn) {
  // GET /api/models — live model lists from the installed claude + codex CLIs.
  // Either side may be null (CLI missing/erroring); the frontend falls back to
  // its static lists for that provider.
  use("/api/models", async (req, res, next) => {
    if (req.method !== "GET") return next()
    const forceRefresh = (req.url || "").includes("refresh=1")
    const catalog = await getModelCatalog(forceRefresh)
    res.statusCode = 200
    res.setHeader("Content-Type", "application/json")
    res.end(JSON.stringify(catalog))
  })
}
