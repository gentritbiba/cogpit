import { createRequire } from "node:module"
import { query, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk"
import type { UseFn } from "../helpers"
import { resolveClaudeCliPath } from "../sdk-session"

const CACHE_TTL_MS = 5 * 60 * 1000
const CONTROL_TIMEOUT_MS = 20_000

const CLAUDE_CLI_PATH = resolveClaudeCliPath((id) =>
  createRequire(import.meta.url).resolve(id),
)

interface ClaudeRuntimeSnapshot {
  available: true
  account: unknown
  usage: unknown
  models: unknown[]
  agents: unknown[]
  fetchedAt: number
}

let cached: ClaudeRuntimeSnapshot | null = null
let inFlight: Promise<ClaudeRuntimeSnapshot> | null = null

function withTimeout<T>(promise: Promise<T>, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`${label} timed out after ${CONTROL_TIMEOUT_MS}ms`)),
      CONTROL_TIMEOUT_MS,
    )
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error) => {
        clearTimeout(timer)
        reject(error)
      },
    )
  })
}

async function bestEffort<T>(promise: Promise<T>): Promise<T | null> {
  try {
    return await promise
  } catch {
    return null
  }
}

/**
 * Read account and plan usage through Claude's authenticated SDK control
 * channel. This avoids reading OAuth secrets from the macOS Keychain and works
 * on every platform supported by the Agent SDK.
 */
export async function getClaudeRuntimeSnapshot(force = false): Promise<ClaudeRuntimeSnapshot> {
  if (!force && cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) return cached
  if (inFlight) return inFlight

  inFlight = (async () => {
    const abort = new AbortController()
    const control = query({
      // Keep the input channel open: this query exists only for SDK control
      // requests and never sends a model turn.
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

    try {
      const [account, usage, models, agents] = await withTimeout(
        Promise.all([
          bestEffort(control.accountInfo()),
          bestEffort(control.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET()),
          bestEffort(control.supportedModels()),
          bestEffort(control.supportedAgents()),
        ]),
        "claude runtime",
      )
      cached = {
        available: true,
        account,
        usage,
        models: models ?? [],
        agents: agents ?? [],
        fetchedAt: Date.now(),
      }
      return cached
    } finally {
      abort.abort()
      control.close()
    }
  })()

  try {
    return await inFlight
  } finally {
    inFlight = null
  }
}

export function registerClaudeRuntimeRoutes(
  use: UseFn,
  getSnapshot: (force?: boolean) => Promise<ClaudeRuntimeSnapshot> = getClaudeRuntimeSnapshot,
) {
  use("/api/claude/runtime", (req, res, next) => {
    if (req.method !== "GET") return next()
    const url = new URL(req.url ?? "/", "http://localhost")
    if (url.pathname !== "/" && url.pathname !== "") return next()

    void getSnapshot(url.searchParams.get("refresh") === "1").then(
      (snapshot) => {
        res.statusCode = 200
        res.setHeader("Content-Type", "application/json")
        res.end(JSON.stringify(snapshot))
      },
      (error) => {
        res.statusCode = 502
        res.setHeader("Content-Type", "application/json")
        res.end(JSON.stringify({
          available: false,
          error: error instanceof Error ? error.message : "Claude runtime unavailable",
        }))
      },
    )
  })
}
