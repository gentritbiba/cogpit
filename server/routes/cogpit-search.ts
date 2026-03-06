/**
 * /api/cogpit-search — deep session search powered by local cogpit-memory CLI.
 *
 * Shells out to the cogpit-memory CLI and maps results to ActiveSessionInfo[]
 * so the LiveSessions UI can render them directly.
 *
 * In dev: runs `bun packages/cogpit-memory/src/cli.ts` (source, fast reload)
 * In packaged app: runs `node packages/cogpit-memory/dist/cli.js` (compiled)
 */

import { execFile as execFileCb } from "node:child_process"
import { existsSync } from "node:fs"
import { join } from "node:path"
import { promisify } from "node:util"
import type { UseFn } from "../helpers"
import { findJsonlPath, getSessionMeta, projectDirToReadableName, sendJson, stat, basename, dirname } from "../helpers"

const execFileAsync = promisify(execFileCb)
const cliEnv = { ...process.env, ELECTRON_RUN_AS_NODE: "1" }

function getCliConfig(): { executable: string; script: string } {
  // Dev mode: __dirname = server/routes/ (via Vite middleware)
  const devTs = join(__dirname, "..", "..", "packages", "cogpit-memory", "src", "cli.ts")
  if (existsSync(devTs)) {
    return { executable: "bun", script: devTs }
  }
  // Packaged app: __dirname is inside app.asar/out/main/
  // asarUnpack extracts files to app.asar.unpacked/ alongside app.asar
  const asarRoot = join(__dirname, "..", "..")
  const unpackedRoot = asarRoot.replace("app.asar", "app.asar.unpacked")
  return {
    executable: process.execPath,
    script: join(unpackedRoot, "packages", "cogpit-memory", "dist", "cli.js"),
  }
}

async function runCli(args: string[]): Promise<string> {
  const { executable, script } = getCliConfig()
  try {
    const { stdout } = await execFileAsync(executable, [script, ...args], {
      timeout: 30_000,
      env: cliEnv,
    })
    return stdout
  } catch (err: unknown) {
    // promisified execFile attaches stderr to the error object
    const stderr = (err as { stderr?: string }).stderr
    throw new Error(stderr || (err instanceof Error ? err.message : String(err)))
  }
}

interface SearchResult {
  sessionId: string
  cwd: string
  hits: Array<{ snippet: string }>
}

async function buildSessionInfo(sr: SearchResult) {
  const jsonlPath = await findJsonlPath(sr.sessionId)
  if (!jsonlPath) return null

  const dirName = basename(dirname(jsonlPath))
  const fileName = basename(jsonlPath)

  let meta: Awaited<ReturnType<typeof getSessionMeta>> | null = null
  let fileSize = 0
  let mtimeMs = 0
  try {
    const [m, s] = await Promise.all([getSessionMeta(jsonlPath), stat(jsonlPath)])
    meta = m
    fileSize = s.size
    mtimeMs = s.mtimeMs
  } catch { /* file may have been deleted between search and metadata fetch */ }

  const { shortName } = projectDirToReadableName(dirName)

  return {
    dirName,
    projectShortName: shortName,
    fileName,
    sessionId: sr.sessionId,
    slug: meta?.slug,
    firstUserMessage: meta?.firstUserMessage,
    lastUserMessage: meta?.lastUserMessage,
    gitBranch: meta?.gitBranch,
    cwd: sr.cwd || meta?.cwd,
    lastModified: mtimeMs ? new Date(mtimeMs).toISOString() : new Date().toISOString(),
    turnCount: meta?.turnCount,
    size: fileSize,
    isActive: mtimeMs ? Date.now() - mtimeMs < 5 * 60 * 1000 : false,
    matchedMessage: sr.hits[0]?.snippet || "",
    hitCount: sr.hits.length,
  }
}

export function registerCogpitSearchRoutes(use: UseFn) {
  use("/api/cogpit-search", async (req, res, next) => {
    if (req.method !== "GET") return next()

    const url = new URL(req.url || "/", "http://localhost")
    const query = url.searchParams.get("q")
    const limitRaw = url.searchParams.get("limit") || "20"
    const maxAge = url.searchParams.get("maxAge") || "30d"

    if (!query || query.length < 2) {
      return sendJson(res, 400, { error: "Query parameter 'q' is required and must be at least 2 characters" })
    }

    const limit = Math.min(Math.max(1, parseInt(limitRaw, 10) || 20), 100)

    try {
      const stdout = await runCli([
        "search", query,
        "--limit", String(limit),
        "--max-age", maxAge,
      ])

      let result: { error?: string; results?: SearchResult[] }
      try {
        result = JSON.parse(stdout)
      } catch {
        return sendJson(res, 500, { error: "CLI returned invalid JSON", output: stdout.slice(0, 500) })
      }

      if (result.error) {
        return sendJson(res, 400, result)
      }

      if (!Array.isArray(result.results)) {
        return sendJson(res, 500, { error: "Unexpected CLI response shape" })
      }

      const sessions = await Promise.all(
        result.results.map(buildSessionInfo)
      )

      sendJson(res, 200, sessions.filter(Boolean))
    } catch (err) {
      sendJson(res, 500, { error: String(err) })
    }
  })
}
