# cogpit-memory

CLI tool that gives any AI assistant memory of past [Claude Code](https://docs.anthropic.com/en/docs/claude-code) sessions. Retrieve conversation history, tool usage, thinking blocks, sub-agent activity, and full-text search across all sessions.

All output is JSON to stdout — designed for programmatic consumption by AI agents.

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
```

| Flag | Default | Description |
|------|---------|-------------|
| `--session` | all | Scope to single session |
| `--max-age` | `5d` | Time window — any duration (`5d`, `30d`, `365d`) |
| `--limit` | `20` | Max returned hits |
| `--case-sensitive` | `false` | Case sensitivity |

Each hit includes a `location` string (e.g. `turn/3/assistantMessage`, `agent/a7f3bc2/toolCall/tc1/result`) that maps directly to L2/L3 drill-down commands.

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

cogpit-memory reads Claude Code's JSONL session files from `~/.claude/projects/`. It parses the conversation structure (turns, tool calls, thinking blocks, sub-agents) and provides a layered drill-down interface.

For search, it maintains an FTS5 trigram index at `~/.claude/cogpit-memory/search-index.db`. The trigram tokenizer enables substring matching (not just whole-word) — searching for `"auth"` matches `"authentication"`, `"OAuth"`, and `"AuthProvider"`.

## Development

Requires [Bun](https://bun.sh) for development (source uses `bun:sqlite`). The npm build uses `better-sqlite3` for Node.js compatibility via an esbuild alias.

```bash
# Run tests (82 tests)
bun test

# Build compiled binary (Bun, uses bun:sqlite)
bun run build

# Build for npm (Node.js, uses better-sqlite3)
bun run build:npm
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

Installs into a single project's `.claude/skills/`:

```bash
npx cogpit-memory install-skill

# Or specify a project directory
npx cogpit-memory install-skill --cwd /path/to/project
```

Once installed, your AI agent will automatically use `cogpit-memory` when it needs to recall past session context or search conversation history.

## License

MIT
