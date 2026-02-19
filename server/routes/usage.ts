import { readdir, stat, open } from "node:fs/promises"
import { join } from "node:path"
import { spawn } from "node:child_process"
import { dirs } from "../helpers"
import type { UseFn } from "../helpers"

// ── Types ──────────────────────────────────────────────────────────────

interface UsageData {
  /** Output tokens in the current 5h session window */
  sessionWindow: { outputTokens: number; resetAt: string }
  /** Output tokens this week (Mon–Sun) */
  weekly: { outputTokens: number; resetAt: string }
  /** Subscription type from `claude auth status` */
  subscriptionType: string | null
}

// ── Cache ──────────────────────────────────────────────────────────────

let cachedUsage: UsageData | null = null
let cachedAt = 0
const CACHE_TTL_MS = 30_000 // 30 seconds

let cachedSubscriptionType: string | null = null
let subscriptionFetched = false

// ── Subscription detection ─────────────────────────────────────────────

function fetchSubscriptionType(): Promise<string | null> {
  if (subscriptionFetched) return Promise.resolve(cachedSubscriptionType)

  return new Promise((resolve) => {
    const cleanEnv = { ...process.env }
    delete cleanEnv.CLAUDECODE

    const child = spawn("claude", ["auth", "status"], {
      env: cleanEnv,
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5000,
    })

    let stdout = ""
    child.stdout.on("data", (d: Buffer) => { stdout += d.toString() })
    child.on("close", () => {
      subscriptionFetched = true
      try {
        const parsed = JSON.parse(stdout)
        cachedSubscriptionType = parsed.subscriptionType ?? null
      } catch {
        cachedSubscriptionType = null
      }
      resolve(cachedSubscriptionType)
    })
    child.on("error", () => {
      subscriptionFetched = true
      resolve(null)
    })
  })
}

// ── Token aggregation from JSONL files ─────────────────────────────────

// Regex to extract output_tokens values from JSONL lines
const OUTPUT_TOKENS_RE = /"output_tokens"\s*:\s*(\d+)/g

async function aggregateTokens(): Promise<{ sessionTokens: number; weeklyTokens: number }> {
  const now = Date.now()
  const FIVE_HOURS_MS = 5 * 60 * 60 * 1000
  const sessionCutoff = now - FIVE_HOURS_MS

  // Compute start of current week (Monday 00:00 local time)
  const today = new Date()
  const dayOfWeek = today.getDay() // 0=Sun, 1=Mon, ...
  const mondayOffset = dayOfWeek === 0 ? 6 : dayOfWeek - 1
  const weekStart = new Date(today)
  weekStart.setDate(today.getDate() - mondayOffset)
  weekStart.setHours(0, 0, 0, 0)
  const weekCutoff = weekStart.getTime()

  let sessionTokens = 0
  let weeklyTokens = 0

  if (!dirs.PROJECTS_DIR) return { sessionTokens, weeklyTokens }

  try {
    const projects = await readdir(dirs.PROJECTS_DIR, { withFileTypes: true })

    for (const project of projects) {
      if (!project.isDirectory() || project.name === "memory") continue
      const projectDir = join(dirs.PROJECTS_DIR, project.name)

      let files: string[]
      try {
        files = await readdir(projectDir)
      } catch { continue }

      for (const file of files) {
        if (!file.endsWith(".jsonl")) continue
        const filePath = join(projectDir, file)

        let fileStat: Awaited<ReturnType<typeof stat>>
        try {
          fileStat = await stat(filePath)
        } catch { continue }

        const mtime = fileStat.mtimeMs

        // Skip files older than this week
        if (mtime < weekCutoff) continue

        // Read the file and extract output tokens
        const tokens = await extractOutputTokens(filePath)

        if (mtime >= sessionCutoff) {
          sessionTokens += tokens
        }
        weeklyTokens += tokens
      }
    }
  } catch {
    // PROJECTS_DIR might not exist
  }

  return { sessionTokens, weeklyTokens }
}

async function extractOutputTokens(filePath: string): Promise<number> {
  let total = 0
  // Only read up to 1MB for quick scanning (large files get truncated)
  const MAX_READ = 1024 * 1024

  try {
    const fileStat = await stat(filePath)
    const readSize = Math.min(fileStat.size, MAX_READ)
    const fh = await open(filePath, "r")
    try {
      const buf = Buffer.alloc(readSize)
      const { bytesRead } = await fh.read(buf, 0, readSize, 0)
      const text = buf.subarray(0, bytesRead).toString("utf-8")

      // Deduplicate by message ID: Claude Code writes multiple JSONL entries per API call
      // (one per content block) with identical usage. Only count each message ID once.
      const seenIds = new Set<string>()

      for (const line of text.split("\n")) {
        if (!line.includes('"output_tokens"')) continue
        if (!line.includes('"assistant"')) continue
        try {
          const obj = JSON.parse(line)
          if (obj.type === "assistant" && obj.message?.usage?.output_tokens) {
            const msgId = obj.message.id
            if (msgId && seenIds.has(msgId)) continue
            if (msgId) seenIds.add(msgId)
            total += obj.message.usage.output_tokens
          }
        } catch {
          // skip malformed lines
        }
      }
    } finally {
      await fh.close()
    }
  } catch {
    // file may not be readable
  }
  return total
}

// ── Session window reset time calculation ──────────────────────────────

function computeSessionResetAt(): string {
  // Session windows reset every 5 hours. Approximate the next reset
  // based on the assumption that the current window started at the most
  // recent 5-hour boundary (midnight, 5am, 10am, 3pm, 8pm).
  const now = new Date()
  const hours = now.getHours()
  const boundaries = [0, 5, 10, 15, 20]
  let currentBoundary = 0
  for (const b of boundaries) {
    if (hours >= b) currentBoundary = b
  }
  const resetDate = new Date(now)
  resetDate.setHours(currentBoundary + 5, 0, 0, 0)
  // If the computed reset is in the past (shouldn't happen), push to next boundary
  if (resetDate.getTime() <= now.getTime()) {
    resetDate.setHours(resetDate.getHours() + 5)
  }
  return resetDate.toISOString()
}

function computeWeeklyResetAt(): string {
  // Weekly resets at the start of next week (Monday 00:00 local)
  const now = new Date()
  const dayOfWeek = now.getDay() // 0=Sun
  const daysUntilMonday = dayOfWeek === 0 ? 1 : 8 - dayOfWeek
  const resetDate = new Date(now)
  resetDate.setDate(now.getDate() + daysUntilMonday)
  resetDate.setHours(0, 0, 0, 0)
  return resetDate.toISOString()
}

// ── Route handler ──────────────────────────────────────────────────────

export function registerUsageRoutes(use: UseFn) {
  use("/api/usage", (req, res, next) => {
    if (req.method !== "GET") return next()

    const now = Date.now()

    // Return cached data if fresh
    if (cachedUsage && now - cachedAt < CACHE_TTL_MS) {
      res.setHeader("Content-Type", "application/json")
      res.end(JSON.stringify(cachedUsage))
      return
    }

    // Compute fresh usage data
    Promise.all([aggregateTokens(), fetchSubscriptionType()])
      .then(([{ sessionTokens, weeklyTokens }, subType]) => {
        const usage: UsageData = {
          sessionWindow: {
            outputTokens: sessionTokens,
            resetAt: computeSessionResetAt(),
          },
          weekly: {
            outputTokens: weeklyTokens,
            resetAt: computeWeeklyResetAt(),
          },
          subscriptionType: subType,
        }

        cachedUsage = usage
        cachedAt = Date.now()

        res.setHeader("Content-Type", "application/json")
        res.end(JSON.stringify(usage))
      })
      .catch(() => {
        res.statusCode = 500
        res.setHeader("Content-Type", "application/json")
        res.end(JSON.stringify({ error: "Failed to compute usage" }))
      })
  })
}
