/**
 * cogpit-memory CLI — query Claude Code session history.
 *
 * Usage:
 *   cogpit-memory search <query> [options]
 *   cogpit-memory context <sessionId> [--turn N] [--agent ID]
 *   cogpit-memory sessions [--cwd path] [--current] [--limit N] [--max-age 7d]
 *   cogpit-memory index stats|rebuild|sync
 */

import { searchSessions } from "./commands/search"
import { getSessionOverview, getTurnDetail, getAgentOverview, getAgentTurnDetail } from "./commands/context"
import { listSessions, currentSession } from "./commands/sessions"
import { indexStats, indexRebuild, indexSync } from "./commands/index-cmd"
import { MAX_AGE_HELP, parseMaxAge } from "./lib/response"
import type { SyncSummary } from "./lib/sync"
import { installSkill } from "./commands/install-skill"

export interface CLICommand {
  command: string
  args: CLIArguments
  error?: string
}

export interface CLIArguments {
  query?: string
  session?: string
  excludeSession?: string
  maxAge?: string
  limit?: number
  sessionLimit?: number
  hitsPerSession?: number
  caseSensitive?: boolean
  sessionId?: string
  turnIndex?: number
  agentId?: string
  cwd?: string
  current?: boolean
  subcommand?: string
  global?: boolean
}

type FlagKind = "string" | "count" | "index" | "maxAge" | "switch"
type FlagTable = Record<string, { key: keyof CLIArguments; kind: FlagKind }>

const COMMAND_FLAGS: Record<string, { positional?: "query" | "sessionId"; flags: FlagTable }> = {
  search: {
    positional: "query",
    flags: {
      "--session": { key: "session", kind: "string" },
      "--exclude-session": { key: "excludeSession", kind: "string" },
      "--max-age": { key: "maxAge", kind: "maxAge" },
      "--limit": { key: "limit", kind: "count" },
      "--session-limit": { key: "sessionLimit", kind: "count" },
      "--hits-per-session": { key: "hitsPerSession", kind: "count" },
      "--case-sensitive": { key: "caseSensitive", kind: "switch" },
    },
  },
  context: {
    positional: "sessionId",
    flags: {
      "--turn": { key: "turnIndex", kind: "index" },
      "--agent": { key: "agentId", kind: "string" },
    },
  },
  sessions: {
    flags: {
      "--cwd": { key: "cwd", kind: "string" },
      "--limit": { key: "limit", kind: "count" },
      "--max-age": { key: "maxAge", kind: "maxAge" },
      "--current": { key: "current", kind: "switch" },
    },
  },
  "install-skill": {
    flags: {
      "--cwd": { key: "cwd", kind: "string" },
      "-g": { key: "global", kind: "switch" },
      "--global": { key: "global", kind: "switch" },
    },
  },
}

const INDEX_SUBCOMMANDS = new Set(["stats", "rebuild", "sync"])

function flagValue(flag: string, kind: FlagKind, raw: string | undefined): { value: string | number | boolean } | { error: string } {
  if (kind === "switch") return { value: true }
  if (raw === undefined) return { error: `${flag} needs a value` }
  if (kind === "string") return { value: raw }
  if (kind === "maxAge") return parseMaxAge(raw) === null ? { error: `Invalid ${flag} "${raw}": ${MAX_AGE_HELP}` } : { value: raw }
  const number = /^\d+$/.test(raw) ? Number(raw) : NaN
  if (kind === "count" && !(number >= 1)) return { error: `Invalid ${flag} "${raw}": use a whole number of 1 or more` }
  if (kind === "index" && !(number >= 0)) return { error: `Invalid ${flag} "${raw}": use a whole number of 0 or more` }
  return { value: number }
}

/** A bad flag or value is reported in `error` rather than ignored. */
export function parseArgs(argv: string[]): CLICommand {
  const command = argv[0]
  const args: CLIArguments = {}

  if (command === "index") {
    args.subcommand = argv[1] ?? "stats"
    if (!INDEX_SUBCOMMANDS.has(args.subcommand)) return { command, args, error: `Unknown index command: ${args.subcommand}. Use stats, rebuild or sync.` }
    if (argv.length > 2) return { command, args, error: `Unexpected argument: ${argv[2]}` }
    return { command, args }
  }

  const spec = COMMAND_FLAGS[command]
  if (!spec) return { command, args }
  let i = 1
  if (spec.positional) args[spec.positional] = argv[i++]
  for (; i < argv.length; i++) {
    const flag = spec.flags[argv[i]]
    if (!flag) return { command, args, error: `Unknown option for ${command}: ${argv[i]}` }
    const parsed = flagValue(argv[i], flag.kind, flag.kind === "switch" ? undefined : argv[++i])
    if ("error" in parsed) return { command, args, error: parsed.error }
    ;(args as Record<string, unknown>)[flag.key] = parsed.value
  }
  return { command, args }
}

async function main() {
  const argv = process.argv.slice(2)
  if (argv.length === 0 || argv[0] === "--help" || argv[0] === "-h") {
    printUsage()
    process.exit(0)
  }

  const cmd = parseArgs(argv)
  if (cmd.error) {
    console.error(JSON.stringify({ error: cmd.error }))
    process.exit(1)
  }
  let result: unknown

  switch (cmd.command) {
    case "search": {
      if (!cmd.args.query) {
        console.error(JSON.stringify({ error: "Usage: cogpit-memory search <query>" }))
        process.exit(1)
      }
      const searchResult = await searchSessions(cmd.args.query, {
        sessionId: cmd.args.session,
        excludeSessionId: cmd.args.excludeSession,
        maxAge: cmd.args.maxAge,
        limit: cmd.args.limit,
        caseSensitive: cmd.args.caseSensitive,
      })
      // --session-limit: cap unique sessions, --hits-per-session: trim hits per session
      if ("results" in searchResult && (cmd.args.sessionLimit || cmd.args.hitsPerSession)) {
        const sl = cmd.args.sessionLimit ?? searchResult.results.length
        const hpp = cmd.args.hitsPerSession ?? Infinity
        searchResult.results = searchResult.results.slice(0, sl).map(sr => ({
          ...sr,
          hits: sr.hits.slice(0, hpp),
        }))
        searchResult.returnedHits = searchResult.results.reduce((n, sr) => n + sr.hits.length, 0)
      }
      result = searchResult
      break
    }

    case "context":
      if (!cmd.args.sessionId) {
        console.error(JSON.stringify({ error: "Usage: cogpit-memory context <sessionId>" }))
        process.exit(1)
      }
      if (cmd.args.agentId && cmd.args.turnIndex !== undefined) {
        result = await getAgentTurnDetail(cmd.args.sessionId, cmd.args.agentId, cmd.args.turnIndex)
      } else if (cmd.args.agentId) {
        result = await getAgentOverview(cmd.args.sessionId, cmd.args.agentId)
      } else if (cmd.args.turnIndex !== undefined) {
        result = await getTurnDetail(cmd.args.sessionId, cmd.args.turnIndex)
      } else {
        result = await getSessionOverview(cmd.args.sessionId)
      }
      break

    case "sessions":
      if (cmd.args.current) {
        result = await currentSession(cmd.args.cwd ?? process.cwd())
      } else {
        result = await listSessions({
          cwd: cmd.args.cwd,
          limit: cmd.args.limit,
          maxAge: cmd.args.maxAge,
        })
      }
      break

    case "index":
      if (cmd.args.subcommand === "rebuild") {
        result = await indexRebuild()
      } else if (cmd.args.subcommand === "sync") {
        result = await indexSync({ onProgress: progressReporter() })
      } else {
        result = await indexStats()
      }
      break

    case "install-skill":
      result = installSkill(cmd.args.cwd, cmd.args.global)
      break

    default:
      console.error(JSON.stringify({ error: `Unknown command: ${cmd.command}` }))
      printUsage()
      process.exit(1)
  }

  console.log(JSON.stringify(result, null, 2))
  if (result && typeof result === "object" && "error" in result) process.exitCode = 1
}

/** Progress on stderr every two seconds, so stdout stays one JSON document. */
function progressReporter(): (summary: SyncSummary) => void {
  let last = Date.now()
  return (summary) => {
    if (Date.now() - last < 2000) return
    last = Date.now()
    console.error(`index sync: parsed ${summary.parsed} transcripts, ${summary.chunks.added} chunks added`)
  }
}

function printUsage() {
  console.log(`cogpit-memory - query Claude Code session history

Commands:
  search <query> [options]    Ranked search: prose by keywords, tool calls by phrase
    --session <id>            Scope to single session
    --exclude-session <id>    Omit a session and its subagents from search
    --max-age <5d>            Time window (default: all time for prose, 5d for tool calls)
    --limit <20>              Max hits (default: 20)
    --session-limit <N>       Cap unique sessions returned
    --hits-per-session <N>    Max hits kept per session
    --case-sensitive          Case sensitive matching

  context <sessionId>         Session overview (L1)
    --turn <N>                Turn detail (L2)
    --agent <id>              Sub-agent overview (L3)

  sessions [options]          List sessions
    --cwd <path>              Filter by working directory
    --limit <20>              Max results (default: 20)
    --max-age <7d>            Time window (default: 7d)
    --current                 Most recent session for --cwd

  index stats                 Show tool index and memory store stats
  index rebuild               Rebuild the tool index (never the memory store)
  index sync                  Bring both stores fully up to date

  install-skill [options]      Install Claude Code skill
    --cwd <path>              Target project directory
    -g, --global              Install to ~/.claude/skills/ (all projects)
`)
}

// Run main() when executed directly (not when imported for testing).
// Detection covers: Bun compiled binary, bun src/cli.ts, node dist/cli.js,
// and npx symlink (where argv[1] may be "cogpit-memory" not "cli.js").
const isBunCompiled = typeof Bun !== "undefined" && !process.argv[1]?.endsWith(".ts")
const isNodeScript = process.argv[1]?.endsWith("/cli.ts") || process.argv[1]?.endsWith("/cli.js")
// CJS bundled output: require.main === module (works for npx symlinks too)
const isCjsMain = typeof require !== "undefined" && typeof module !== "undefined" && require.main === module

if (isBunCompiled || isNodeScript || isCjsMain) {
  main().catch((err) => {
    console.error(JSON.stringify({ error: String(err) }))
    process.exit(1)
  })
}
