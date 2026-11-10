/**
 * cogpit-memory CLI — query Claude Code session history.
 *
 * Usage:
 *   cogpit-memory search <query> [options]
 *   cogpit-memory context <sessionId> [--turn N] [--agent ID]
 *   cogpit-memory sessions [--cwd path] [--current] [--limit N] [--max-age 7d]
 *   cogpit-memory index stats|rebuild|sync|config
 */

import { searchSessions } from "./commands/search"
import { getSessionOverview, getTurnDetail, getAgentOverview, getAgentTurnDetail } from "./commands/context"
import { listSessions, currentSession } from "./commands/sessions"
import { indexStats, indexRebuild, indexSync, indexConfig, type SyncProgress } from "./commands/index-cmd"
import { SEARCH_MODES, type SearchMode } from "./lib/memory/search"
import type { EmbeddingConfig } from "./lib/memory/embeddings"
import { MAX_AGE_HELP, parseMaxAge } from "./lib/response"

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
  mode?: SearchMode
  /** `index config` changes to the embedding endpoint. */
  embeddings?: Partial<EmbeddingConfig>
  embeddingsOff?: boolean
}

type FlagKind = "string" | "count" | "index" | "maxAge" | "switch" | "score" | "mode"
type FlagTable = Record<string, { key: keyof CLIArguments | `embeddings.${keyof EmbeddingConfig}`; kind: FlagKind }>

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
      "--mode": { key: "mode", kind: "mode" },
    },
  },
  "index config": {
    flags: {
      "--url": { key: "embeddings.url", kind: "string" },
      "--model": { key: "embeddings.model", kind: "string" },
      "--api-key": { key: "embeddings.apiKey", kind: "string" },
      "--dimensions": { key: "embeddings.dimensions", kind: "count" },
      "--query-prefix": { key: "embeddings.queryPrefix", kind: "string" },
      "--min-score": { key: "embeddings.minScore", kind: "score" },
      "--timeout-ms": { key: "embeddings.timeoutMs", kind: "count" },
      "--off": { key: "embeddingsOff", kind: "switch" },
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

const INDEX_SUBCOMMANDS = new Set(["stats", "rebuild", "sync", "config"])

function flagValue(flag: string, kind: FlagKind, raw: string | undefined): { value: string | number | boolean } | { error: string } {
  if (kind === "switch") return { value: true }
  if (raw === undefined) return { error: `${flag} needs a value` }
  if (kind === "string") return { value: raw }
  if (kind === "maxAge") return parseMaxAge(raw) === null ? { error: `Invalid ${flag} "${raw}": ${MAX_AGE_HELP}` } : { value: raw }
  if (kind === "mode") return (SEARCH_MODES as readonly string[]).includes(raw) ? { value: raw } : { error: `Invalid ${flag} "${raw}": use ${SEARCH_MODES.join(", ")}` }
  if (kind === "score") {
    const score = /^-?\d*\.?\d+$/.test(raw) ? Number(raw) : NaN
    return score >= -1 && score <= 1 ? { value: score } : { error: `Invalid ${flag} "${raw}": use a number from -1 to 1` }
  }
  const number = /^\d+$/.test(raw) ? Number(raw) : NaN
  if (kind === "count" && !(number >= 1)) return { error: `Invalid ${flag} "${raw}": use a whole number of 1 or more` }
  if (kind === "index" && !(number >= 0)) return { error: `Invalid ${flag} "${raw}": use a whole number of 0 or more` }
  return { value: number }
}

/** A bad flag or value is reported in `error` rather than ignored. */
export function parseArgs(argv: string[]): CLICommand {
  const command = argv[0]
  const args: CLIArguments = {}

  let specName = command
  let i = 1
  if (command === "index") {
    args.subcommand = argv[1] ?? "stats"
    if (!INDEX_SUBCOMMANDS.has(args.subcommand)) return { command, args, error: `Unknown index command: ${args.subcommand}. Use stats, rebuild, sync or config.` }
    if (args.subcommand !== "config") return argv.length > 2 ? { command, args, error: `Unexpected argument: ${argv[2]}` } : { command, args }
    specName = "index config"
    i = 2
  }

  const spec = COMMAND_FLAGS[specName]
  if (!spec) return { command, args }
  if (spec.positional) args[spec.positional] = argv[i++]
  for (; i < argv.length; i++) {
    const flag = spec.flags[argv[i]]
    if (!flag) return { command, args, error: `Unknown option for ${specName}: ${argv[i]}` }
    const parsed = flagValue(argv[i], flag.kind, flag.kind === "switch" ? undefined : argv[++i])
    if ("error" in parsed) return { command, args, error: parsed.error }
    if (flag.key.startsWith("embeddings.")) args.embeddings = { ...args.embeddings, [flag.key.slice("embeddings.".length)]: parsed.value }
    else (args as Record<string, unknown>)[flag.key] = parsed.value
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
        mode: cmd.args.mode,
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
        result = await indexSync({ progress: progressReporter() })
      } else if (cmd.args.subcommand === "config") {
        result = await indexConfig(cmd.args.embeddings ?? {}, cmd.args.embeddingsOff)
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
function progressReporter(): SyncProgress {
  let last = Date.now()
  const report = (line: string) => {
    if (Date.now() - last < 2000) return
    last = Date.now()
    console.error(`index sync: ${line}`)
  }
  return {
    sync: (summary) => report(`parsed ${summary.parsed} transcripts, ${summary.chunks.added} chunks added`),
    embed: (embedded, remaining) => report(`embedded ${embedded} passages, about ${remaining} to go`),
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
    --mode <hybrid>           hybrid (keywords + meaning), keyword or semantic

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
  index sync                  Bring both stores up to date and embed pending passages
  index config [options]      Show or set the embedding endpoint (config.json)
    --url <url> --model <name>  OpenAI-compatible /v1/embeddings endpoint and model
    --dimensions <256>        Dimensions kept per vector
    --query-prefix <text>     Prepended to queries (instruction-tuned models)
    --min-score <0.55>        Similarity a hit by meaning must reach
    --timeout-ms <1500>       Query embedding timeout
    --api-key <key>           Bearer token, if the endpoint needs one
    --off                     Turn embeddings off

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
