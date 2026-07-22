# cogpit-memory

CLI tool that gives any AI assistant memory of past Claude Code and Codex
sessions. Browse either provider's conversation history, tool usage, thinking
blocks, and sub-agent activity. Cross-session FTS search currently indexes
Claude Code history.

All output is JSON to stdout — designed for programmatic consumption by AI agents.

Session compatibility is validated against Claude Code 2.1.217 and Codex CLI
0.145.0. The parser also retains backward compatibility with older rollout
formats covered by the test suite.

## Install

```bash
npm install -g cogpit-memory
```

Or run directly:

```bash
npx cogpit-memory sessions
```

## Quick Start

```bash
# List recent sessions
cogpit-memory sessions

# Get session overview
cogpit-memory context <sessionId>

# Drill into a specific turn
cogpit-memory context <sessionId> --turn 3

# Search across all sessions
cogpit-memory search "authentication"
```

## Commands

### `sessions` — Discover sessions

```bash
cogpit-memory sessions                              # Recent sessions (last 7 days)
cogpit-memory sessions --cwd /path/to/project       # Filter by project
cogpit-memory sessions --current --cwd /path/to/project  # Most recent for a project
cogpit-memory sessions --max-age 90d --limit 50     # Custom window
```

| Flag | Default | Description |
|------|---------|-------------|
| `--cwd` | all | Filter by working directory |
| `--limit` | `20` | Max results |
| `--max-age` | `7d` | Time window — any duration (`7d`, `12h`, `90d`, `365d`) |
| `--current` | — | Most recent session for `--cwd` |

### `context` — Layered session drill-down

Three layers of detail. Start at L1, drill down only as needed.

| Layer | Command | What you get |
|-------|---------|-------------|
| **L1** — Overview | `cogpit-memory context <sessionId>` | Every turn: user prompt, assistant reply, tool summary, sub-agent list |
| **L2** — Turn detail | `cogpit-memory context <sessionId> --turn 3` | Thinking blocks, full tool call I/O, sub-agent summaries (chronological) |
| **L3** — Sub-agent | `cogpit-memory context <sessionId> --agent <agentId>` | Full sub-agent conversation (same shape as L1) |
| **L3** — Sub-agent turn | `cogpit-memory context <sessionId> --agent <agentId> --turn 0` | Sub-agent turn detail (same shape as L2) |

**Discovery flow:** L1 gives you `turnIndex` and `agentId` values → use those to drill into L2/L3.

### `search` — Full-text search with FTS5

Searches everything: user messages, assistant responses, thinking blocks, tool call inputs/outputs, sub-agent content, and compaction summaries.

```bash
cogpit-memory search "authentication"                        # Cross-session search
cogpit-memory search "auth" --session <sessionId>            # Single session
cogpit-memory search "bug" --max-age 30d --limit 50          # Custom window
cogpit-memory search "AuthProvider" --case-sensitive          # Case-sensitive
cogpit-memory search "auth" --limit 200 --session-limit 50    # 50 unique sessions
cogpit-memory search "bug" --session-limit 20 --hits-per-session 2  # Compact results
```

| Flag | Default | Description |
|------|---------|-------------|
| `--session` | all | Scope to single session |
| `--max-age` | `5d` | Time window — any duration (`5d`, `30d`, `365d`) |
| `--limit` | `20` | Max total hits returned |
| `--session-limit` | all | Cap unique sessions in results |
| `--hits-per-session` | all | Max hits kept per session |
| `--case-sensitive` | `false` | Case sensitivity |

Each result includes the `cwd` (working directory where the session ran) and an array of hits. Each hit includes a `location` string (e.g. `turn/3/assistantMessage`, `agent/a7f3bc2/toolCall/tc1/result`) that maps directly to L2/L3 drill-down commands.

### `index` — Manage the FTS5 search index

```bash
cogpit-memory index stats     # Show index stats (session count, DB size, staleness)
cogpit-memory index rebuild   # Rebuild from scratch
```

## Performance

Benchmarked against a real Claude Code history: **765 sessions, 1,745 sub-agents, 210K indexed rows, 1.4 GB index**.

| Operation | Time | Notes |
|-----------|------|-------|
| `sessions --limit 20` | **38ms** | File-system scan, no DB needed |
| `context <sessionId>` (L1) | **34ms** | Single JSONL file parse |
| `context <sessionId> --turn N` (L2) | **35ms** | Same file, filtered to one turn |
| `search "keyword"` (cross-session) | **56–200ms** | FTS5 trigram across 210K rows |
| `search "keyword" --session <id>` | **30ms** | Scoped to single session |
| `index stats` | **50ms** | Single DB query |

### Scaling characteristics

| History size | Sessions | Indexed rows | DB size | Cross-session search |
|-------------|----------|-------------|---------|---------------------|
| Light (3 months) | ~200 | ~50K | ~350 MB | <50ms |
| Moderate (6 months) | ~800 | ~210K | ~1.4 GB | 50–200ms |
| Heavy (1 year) | ~2,000 | ~500K | ~3.5 GB | 100–400ms |
| Power user (2+ years) | ~5,000 | ~1.2M | ~8 GB | 200–800ms |

FTS5 trigram search is sublinear — doubling the index size does not double query time. The index uses SQLite WAL mode for concurrent reads and is incrementally updated.

## How It Works

Session discovery and context commands read Claude Code JSONL history from
`~/.claude/projects/` and Codex JSONL history from `~/.codex/sessions/`. The
shared parser normalizes each provider into the same conversation structure
(turns, tool calls, thinking blocks, and sub-agents) for layered drill-down.

Cross-session search currently builds its FTS5 trigram index from the Claude
project tree and stores it at `~/.claude/cogpit-memory/search-index.db`. The
trigram tokenizer enables substring matching (not just whole-word) — searching
for `"auth"` matches `"authentication"`, `"OAuth"`, and `"AuthProvider"`.

## Development

The npm package requires Node.js 20 or newer. Development requires [Bun](https://bun.sh) because the source uses `bun:sqlite`; the npm build substitutes `better-sqlite3` through an esbuild alias.

The session parser under `src/lib/` is generated from Cogpit's canonical
`shared/session/` implementation. Edit the shared copy, then run
`bun run sync-cogpit-memory` from the Cogpit repository root. CI runs
`bun run check:cogpit-memory-sync` and rejects drift.

```bash
# Run tests
bun test

# Build compiled binary (Bun, uses bun:sqlite)
bun run build

# Build for npm (Node.js, uses better-sqlite3)
bun run build:npm

# Verify built CommonJS, declarations, public exports, CLI, and npm tarball
bun run test:contracts
```

## Agent Skill

cogpit-memory ships with a skill that teaches AI agents how to use it automatically — layered drill-down, search workflows, and all command options. Works with Claude Code, Cursor, Gemini CLI, GitHub Copilot, and more.

### Install via Skills CLI (recommended)

Installs globally across all supported agents:

```bash
npx skills add gentritbiba/cogpit-memory -g -y
```

Browse at [skills.sh](https://skills.sh).

### Install via cogpit-memory CLI

```bash
# Install globally (all projects)
npx cogpit-memory install-skill -g

# Install into a single project's .claude/skills/
npx cogpit-memory install-skill

# Or specify a project directory
npx cogpit-memory install-skill --cwd /path/to/project
```

Once installed, your AI agent will automatically use `cogpit-memory` when it needs to recall past session context or search conversation history.

## License

MIT
