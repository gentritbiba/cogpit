# cogpit-memory

CLI tool that gives any AI assistant memory of past Claude Code, Codex, and
GitHub Copilot CLI sessions. Browse normalized conversation history, tool
usage, thinking blocks, and inline sub-agent activity. Cross-session FTS search
indexes Claude Code, Codex, and GitHub Copilot CLI history.

All output is JSON to stdout — designed for programmatic consumption by AI agents.

Session compatibility is validated against Claude Code 2.1.287 and Codex CLI
0.159.3. The parser also retains backward compatibility with older rollout
formats covered by the test suite. Copilot support follows the documented SDK
event schema and `~/.copilot/session-state/` layout.

## Install

```bash
bun install --global cogpit-memory
```

Use the installed `cogpit-memory` command for repeated or concurrent work. Installing once avoids races between transient `bunx` installs of the native SQLite dependency. Keep stderr separate from stdout when parsing JSON.

## Quick Start

```bash
# List recent sessions
cogpit-memory sessions

# Get session overview
cogpit-memory context <sessionId>

# Drill into a specific turn
cogpit-memory context <sessionId> --turn 3

# Search indexed sessions from all supported CLIs
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

**Discovery flow:** L1 gives you `turnIndex` and `agentId` values. Use those to
drill into L2 and, when a separate sub-agent transcript exists, L3.

Copilot CLI keeps nested agent events in the root `events.jsonl`, so L1 and L2
include that activity inline. L3 needs a separate sub-agent transcript file and
is not available for Copilot sessions.

### `search` — Ranked search over prose and tool calls

One ranked list, merged by reciprocal rank fusion from up to three lists:

- **Prose** — user prompts, assistant replies, thinking, compaction summaries,
  recaps and plans — lives in the durable memory store and is ranked by BM25:
  the query's words are ORed, common words are dropped, and words are stemmed,
  so a question finds the passage that shares most of its rarer words. Quote a
  part of the query to keep it an exact phrase. Prose is searched across **all
  time** unless `--max-age` is given.
- **Meaning** — when an embedding endpoint is configured (see `index config`),
  prose passages similar to the query by meaning, above a similarity floor,
  even when they share no word with it.
- **Tool input and output** come from the FTS5 tool index as exact-phrase hits
  within `--max-age` (default 5 days).

Before a search answers it spends up to 600 ms bringing both stores up to date.
One parse of a file feeds both. Transcripts never indexed go first, then ones
that changed, each newest first. A file whose last sync took longer than the
time left is skipped. A transcript still being written is re-read at most
once per max(1 minute, 20 × its last sync). `--session <id>` brings that
session and its subagents up to date first, outside the budget and the
back-off. The response says how many transcripts are `behind`. Run
`cogpit-memory index sync`, which has no budget, to finish a large backlog.

```bash
cogpit-memory search "authentication"                        # Cross-session index, every agent
cogpit-memory search "auth" --session <sessionId>            # Single session
cogpit-memory search "bug" --max-age 30d --limit 50          # Custom window
cogpit-memory search "AuthProvider" --case-sensitive          # Case-sensitive
cogpit-memory search "auth" --limit 200 --session-limit 50    # 50 unique sessions
cogpit-memory search "bug" --session-limit 20 --hits-per-session 2  # Compact results
```

| Flag | Default | Description |
|------|---------|-------------|
| `--session` | all | Scope to single session |
| `--exclude-session` | none | Exclude one session and its subagents |
| `--max-age` | all time for prose, `5d` for tool calls | Time window — `<number>d`, `h` or `m` |
| `--limit` | `20` | Max total hits returned (1–200) |
| `--session-limit` | all | Cap unique sessions in results |
| `--hits-per-session` | all | Max hits kept per session |
| `--case-sensitive` | `false` | Case sensitivity |
| `--mode` | `hybrid` | `hybrid`, `keyword` (no embeddings) or `semantic` (meaning only, no tool calls) |

An unknown flag or a bad value (`--limit ten`, `--max-age 5days`) is an error, not ignored.

Use `--exclude-session <current-session-id>` when recalling earlier work to omit your own search commands and results.

Each result includes the session's `cwd`, its `title` when known, and an array
of hits, best first. Each hit has:

| Field | Meaning |
|-------|---------|
| `location` | e.g. `turn/3/assistantMessage`, `agent/a7f3bc2/turn/0/userMessage`, `agent/a7f3bc2/toolCall/tc1/result` |
| `turn`, `agent` | Pass to `context <id> --turn N` or `--agent ID [--turn N]` |
| `kind` | `user`, `assistant`, `thinking`, `compaction`, `recap`, `plan`, `agent_message`, `tool_input`, `tool_result` |
| `match` | `keyword`, `semantic` (matched by meaning only) or `both` |
| `similarity` | Cosine similarity to the query, for hits found by meaning |
| `score` | Fused rank score; higher is better |
| `matchCount` | Query-word occurrences in the passage |
| `timestamp` | When the passage was written (prose) |
| `archived`, `text` | The transcript is gone; `text` is the stored passage, and `context` cannot open it |
| `automated` | Written on someone's behalf: crew chat, task wake-ups, other agents |
| `duplicates` | Identical passages in other sessions (forks) folded into this one |

The response also carries `semantic` (`ready`, `unavailable` or `off`) with
`semanticReason`; `behind`, the number of transcripts with turns newer than
the stores; and `warnings` when transcripts were never indexed. Without an
endpoint, or when it does not answer within its timeout, search answers with
keyword results and says why; it never fails because of embeddings.

### `index` — Manage the stores

```bash
cogpit-memory index stats     # Tool index stats plus memory store counts
cogpit-memory index sync      # Bring both stores up to date, then embed pending passages (progress on stderr)
cogpit-memory index config    # Show the embedding endpoint; with flags, change it
cogpit-memory index rebuild   # Rebuild the tool index from scratch; never touches the memory store
```

### Embeddings

Any OpenAI-compatible `/v1/embeddings` endpoint works; nothing is bundled.
The configuration lives in `<memory dir>/config.json`, shared with the
Cogpit app, and is written owner-only. In the app it is under Settings →
Search by meaning (address, model, API key, a test button and indexing
progress); from a terminal:

```bash
cogpit-memory index config --url http://127.0.0.1:8790/v1/embeddings \
  --model Qwen3-Embedding-0.6B --dimensions 256 \
  --query-prefix $'Instruct: Given a question about earlier work, retrieve the conversation passages that answer it\nQuery: '
cogpit-memory index sync      # embeds every passage without a vector
cogpit-memory index config --off
```

| Setting | Default | Meaning |
|---------|---------|---------|
| `url`, `model` | — | Endpoint and model name |
| `apiKey` | none | Sent as a bearer token. Moving `url` to another server drops the saved key unless a new one is given |
| `dimensions` | `256` | Leading dimensions kept per vector (Matryoshka models) |
| `queryPrefix` | none | Prepended to queries only, for instruction-tuned models |
| `minScore` | `0.55` | Similarity a hit by meaning must reach; depends on the model (see below) |
| `timeoutMs` | `1500` | How long a search waits for its query embedding |

The `minScore` default was measured on Qwen3-Embedding-0.6B at 256 dimensions
with an instruction query prefix: questions with an answer scored 0.62–0.81 at
the top, questions with none 0.37–0.54. Other models spread similarities
differently; for one whose real matches score lower, lower `minScore` until a
question you know the answer to finds it.

Vectors are normalised, stored as int8 and compared by brute force in process.
Identical passages share one vector. A vector made by another model or size
counts as pending until `index sync` re-embeds it; text is never re-read from
transcripts for that, so archived passages are re-embedded too.
`COGPIT_EMBED_URL`, `COGPIT_EMBED_MODEL`, `COGPIT_EMBED_API_KEY`,
`COGPIT_EMBED_DIMENSIONS`, `COGPIT_EMBED_QUERY_PREFIX`,
`COGPIT_EMBED_MIN_SCORE` and `COGPIT_EMBED_TIMEOUT_MS` override the file for
tests and one-off runs.

## Performance

Benchmarked against a real Claude Code history: **765 sessions, 1,745 sub-agents, 210K indexed rows, 1.4 GB index**.

| Operation | Time | Notes |
|-----------|------|-------|
| `sessions --limit 20` | **38ms** | File-system scan, no DB needed |
| `context <sessionId>` (L1) | **34ms** | Single JSONL file parse |
| `context <sessionId> --turn N` (L2) | **35ms** | Same file, filtered to one turn |
| `search "keyword"` (cross-session) | **56–200ms** | FTS5 across 210K rows |
| `search "keyword" --session <id>` | **30ms** | Scoped to single session |
| `index stats` | **50ms** | Single DB query |

### Scaling characteristics

| History size | Sessions | Indexed rows | DB size | Cross-session search |
|-------------|----------|-------------|---------|---------------------|
| Light (3 months) | ~200 | ~50K | ~350 MB | <50ms |
| Moderate (6 months) | ~800 | ~210K | ~1.4 GB | 50–200ms |
| Heavy (1 year) | ~2,000 | ~500K | ~3.5 GB | 100–400ms |
| Power user (2+ years) | ~5,000 | ~1.2M | ~8 GB | 200–800ms |

FTS5 search is sublinear — doubling the index size does not double query time. The index uses SQLite WAL mode for concurrent reads and is incrementally updated.

## How It Works

Session discovery and context commands read Claude Code JSONL history from
`~/.claude/projects/`, Codex history from `~/.codex/sessions/`, and GitHub
Copilot CLI history from `~/.copilot/session-state/`. The shared parser
normalizes each provider into the same conversation structure for layered
drill-down.

Tool input and output are indexed in an FTS5 table at
`~/.claude/cogpit-memory/search-index.db` with SQLite's `unicode61` tokenizer, so
a query matches whole tokens: searching for `"auth"` finds `"auth"`, not
`"authentication"`. Its rows are dropped when a transcript disappears.

Prose is kept in the **memory store**, `~/.cogpit/memory/memory.db` (or
`$COGPIT_MEMORY_DIR/memory.db`), shared with the Cogpit app and created
owner-only. It holds each prose block as chunks of up to 2,000 characters with
their session, turn, timestamp, account instance and a title snapshot. Chunks
are **never removed because a transcript was deleted**: they stay searchable and
are reported as `archived`. While a transcript exists, a re-parse replaces what
changed. Inside a Cogpit provider worker, search covers only that account.

## Development

The npm package requires Node.js 20 or newer. Development requires [Bun](https://bun.sh) because the source uses `bun:sqlite`; the npm build substitutes `better-sqlite3` through an esbuild alias.

The session parser under `src/lib/` and the memory store under
`src/lib/memory/` are generated from Cogpit's canonical `shared/session/` and
`shared/memory/` implementations. Edit the shared copy, then run
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
