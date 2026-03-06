/**
 * cogpit-memory CLI — query Claude Code session history.
 *
 * Usage:
 *   cogpit-memory search <query> [options]
 *   cogpit-memory context <sessionId> [--turn N] [--agent ID]
 *   cogpit-memory sessions [--cwd path] [--current] [--limit N] [--max-age 7d]
 *   cogpit-memory index stats|rebuild
 */

import { searchSessions } from "./commands/search"
import { getSessionOverview, getTurnDetail, getAgentOverview, getAgentTurnDetail } from "./commands/context"
import { listSessions, currentSession } from "./commands/sessions"
import { indexStats, indexRebuild } from "./commands/index-cmd"
import { installSkill } from "./commands/install-skill"

export interface CLICommand {
  command: string
  args: Record<string, any>
}

export function parseArgs(argv: string[]): CLICommand {
  const command = argv[0]
  const args: Record<string, any> = {}

  switch (command) {
    case "search": {
      args.query = argv[1]
      for (let i = 2; i < argv.length; i++) {
        switch (argv[i]) {
          case "--session": args.session = argv[++i]; break
          case "--max-age": args.maxAge = argv[++i]; break
          case "--limit": args.limit = parseInt(argv[++i], 10); break
          case "--case-sensitive": args.caseSensitive = true; break
        }
      }
      break
    }
    case "context": {
      args.sessionId = argv[1]
      for (let i = 2; i < argv.length; i++) {
        switch (argv[i]) {
          case "--turn": args.turnIndex = parseInt(argv[++i], 10); break
          case "--agent": args.agentId = argv[++i]; break
        }
      }
      break
    }
    case "sessions": {
      for (let i = 1; i < argv.length; i++) {
        switch (argv[i]) {
          case "--cwd": args.cwd = argv[++i]; break
          case "--limit": args.limit = parseInt(argv[++i], 10); break
          case "--max-age": args.maxAge = argv[++i]; break
          case "--current": args.current = true; break
        }
      }
      break
    }
    case "index": {
      args.subcommand = argv[1] ?? "stats"
      break
    }
    case "install-skill": {
      for (let i = 1; i < argv.length; i++) {
        switch (argv[i]) {
          case "--cwd": args.cwd = argv[++i]; break
          case "-g": case "--global": args.global = true; break
        }
      }
      break
    }
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
  let result: unknown

  switch (cmd.command) {
    case "search":
      if (!cmd.args.query) {
        console.error(JSON.stringify({ error: "Usage: cogpit-memory search <query>" }))
        process.exit(1)
      }
      result = await searchSessions(cmd.args.query, {
        sessionId: cmd.args.session,
        maxAge: cmd.args.maxAge,
        limit: cmd.args.limit,
        caseSensitive: cmd.args.caseSensitive,
      })
      break

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
}

function printUsage() {
  console.log(`cogpit-memory - query Claude Code session history

Commands:
  search <query> [options]    Search across sessions
    --session <id>            Scope to single session
    --max-age <5d>            Time window (default: 5d)
    --limit <20>              Max hits (default: 20)
    --case-sensitive          Case sensitive matching

  context <sessionId>         Session overview (L1)
    --turn <N>                Turn detail (L2)
    --agent <id>              Sub-agent overview (L3)

  sessions [options]          List sessions
    --cwd <path>              Filter by working directory
    --limit <20>              Max results (default: 20)
    --max-age <7d>            Time window (default: 7d)
    --current                 Most recent session for --cwd

  index stats                 Show index stats
  index rebuild               Rebuild full index

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
