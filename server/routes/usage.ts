import { spawn } from "node:child_process"
import type { UseFn } from "../helpers"

interface UsageResponse {
  five_hour?: { utilization: number; resets_at?: string }
  seven_day?: { utilization: number; resets_at?: string }
  seven_day_opus?: { utilization: number; resets_at?: string }
  seven_day_sonnet?: { utilization: number; resets_at?: string }
  extra_usage?: {
    is_enabled: boolean
    monthly_limit?: number
    used_credits?: number
    utilization?: number
  }
}

interface OAuthCredentials {
  accessToken: string
  refreshToken: string
  expiresAt: number
  subscriptionType?: string
}

const OAUTH_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e"
const BETA_HEADER = "oauth-2025-04-20"

/**
 * Read Claude Code OAuth credentials from macOS keychain.
 * Returns null if not on macOS or credentials not found.
 */
async function readKeychainCredentials(): Promise<OAuthCredentials | null> {
  // Only available on macOS
  if (process.platform !== "darwin") {
    return null
  }

  return new Promise((resolve) => {
    let resolved = false
    const done = (value: OAuthCredentials | null) => {
      if (resolved) return
      resolved = true
      resolve(value)
    }

    const child = spawn("/usr/bin/security", [
      "find-generic-password",
      "-s",
      "Claude Code-credentials",
      "-w",
    ])

    let stdout = ""

    child.stdout?.on("data", (data: Buffer) => {
      stdout += data.toString()
    })

    child.on("close", (code) => {
      if (code !== 0) {
        done(null)
        return
      }

      try {
        const jsonString = stdout.trim()
        const jsonData = JSON.parse(jsonString)

        // Handle wrapped format: { "claudeAiOauth": { ... } }
        const creds = jsonData.claudeAiOauth || jsonData

        // Validate required fields
        if (!creds.accessToken || !creds.refreshToken) {
          done(null)
          return
        }

        // Handle both millisecond and second timestamps
        let expiresAt = creds.expiresAt
        if (typeof expiresAt === "number" && expiresAt > 1_000_000_000_000) {
          expiresAt = Math.floor(expiresAt / 1000)
        }

        done({
          accessToken: creds.accessToken,
          refreshToken: creds.refreshToken,
          expiresAt: expiresAt,
          subscriptionType: creds.subscriptionType,
        })
      } catch {
        done(null)
      }
    })

    child.on("error", () => {
      done(null)
    })

    // Timeout after 5 seconds
    setTimeout(() => {
      child.kill()
      done(null)
    }, 5000)
  })
}

/**
 * Refresh OAuth token if needed.
 */
async function refreshTokenIfNeeded(
  creds: OAuthCredentials
): Promise<OAuthCredentials | null> {
  const now = Math.floor(Date.now() / 1000)
  // Refresh if expires in less than 15 minutes
  if (creds.expiresAt - now > 900) {
    return creds
  }

  try {
    const body = new URLSearchParams()
    body.append("grant_type", "refresh_token")
    body.append("refresh_token", creds.refreshToken)
    body.append("client_id", OAUTH_CLIENT_ID)

    const response = await fetch("https://console.anthropic.com/v1/oauth/token", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": "claude-code/0.0.0",
      },
      body: body.toString(),
    })

    if (!response.ok) {
      return null
    }

    const data = (await response.json()) as {
      access_token: string
      refresh_token?: string
      expires_in: number
    }

    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token || creds.refreshToken,
      expiresAt: Math.floor(Date.now() / 1000) + data.expires_in,
      subscriptionType: creds.subscriptionType,
    }
  } catch {
    return null
  }
}

/**
 * Fetch usage from Anthropic's usage API.
 */
async function fetchUsageFromAPI(token: string): Promise<UsageResponse | null> {
  try {
    const response = await fetch("https://api.anthropic.com/api/oauth/usage", {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        "anthropic-beta": BETA_HEADER,
        "User-Agent": "claude-code/0.0.0",
      },
    })

    if (!response.ok) {
      return null
    }

    return (await response.json()) as UsageResponse
  } catch {
    return null
  }
}

export function registerUsageRoutes(use: UseFn) {
  // GET /api/usage - fetch Claude usage stats (macOS only)
  use("/api/usage", async (req, res, next) => {
    if (req.method !== "GET") return next()

    try {
      // Only available on macOS
      if (process.platform !== "darwin") {
        res.statusCode = 501
        res.setHeader("Content-Type", "application/json")
        res.end(JSON.stringify({ error: "Not available on this platform" }))
        return
      }

      // Read credentials from keychain
      const creds = await readKeychainCredentials()
      if (!creds) {
        res.statusCode = 404
        res.setHeader("Content-Type", "application/json")
        res.end(JSON.stringify({ error: "Claude Code credentials not found" }))
        return
      }

      // Refresh token if needed
      const refreshedCreds = await refreshTokenIfNeeded(creds)
      if (!refreshedCreds) {
        res.statusCode = 401
        res.setHeader("Content-Type", "application/json")
        res.end(JSON.stringify({ error: "Failed to refresh token" }))
        return
      }

      // Fetch usage
      const usage = await fetchUsageFromAPI(refreshedCreds.accessToken)
      if (!usage) {
        res.statusCode = 502
        res.setHeader("Content-Type", "application/json")
        res.end(JSON.stringify({ error: "Failed to fetch usage data" }))
        return
      }

      // Return usage with subscription type
      res.statusCode = 200
      res.setHeader("Content-Type", "application/json")
      res.end(
        JSON.stringify({
          ...usage,
          subscriptionType: refreshedCreds.subscriptionType,
        })
      )
    } catch (err) {
      res.statusCode = 500
      res.setHeader("Content-Type", "application/json")
      res.end(JSON.stringify({ error: String(err) }))
    }
  })
}
