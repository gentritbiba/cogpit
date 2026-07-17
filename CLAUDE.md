# Agent Window

## Testing Policy

Any code change MUST account for its impact on existing tests. Before considering a change complete:

1. Run `bun run test` and ensure all tests pass
2. If you changed behavior in a hook or module, check for a corresponding test file in `__tests__/` and update affected tests to match the new behavior
3. If you added new behavior, add test coverage for it
4. Never leave tests broken — fixing tests is part of the change, not a separate task

Test files follow the pattern `src/**/__tests__/*.test.ts` and `server/__tests__/**/*.test.ts`.

## Adding New API Routes

Every new route must be registered in **both** places:

1. `server/api-plugin.ts` — Vite dev server (used during `bun run dev`)
2. `electron/server.ts` — Electron/production Express server (e.g. port 19384)

Registering in only one means the route works in dev but not in the built app, or vice versa.

## External Session API (cogpit-sessions skill)

Other agents can create and manage Claude Code sessions via the HTTP API on `localhost:19384`. Key endpoints:

- `POST /api/create-and-send` — Start a new session with a message (responds in 5–15s)
- `POST /api/send-message` — Send follow-up to an existing session (waits for full turn)
- `POST /api/stop-session` — Stop a running session
- `GET /api/projects` — List available projects and their `dirName`s
- `GET /api/sessions/:dirName/:fileName` — Read session output

See the `cogpit-sessions` skill (`.claude/skills/cogpit-sessions/SKILL.md`) for full usage, timeouts, and permissions.

<!-- gitnexus:start -->
# GitNexus — Code Intelligence

This project is indexed by GitNexus as **cogpit** (4609 symbols, 11740 relationships, 300 execution flows). Use the GitNexus MCP tools to understand code, assess impact, and navigate safely.

> Index stale? Run `node .gitnexus/run.cjs analyze` from the project root — it auto-selects an available runner. No `.gitnexus/run.cjs` yet? `npx gitnexus analyze` (npm 11 crash → `npm i -g gitnexus`; #1939).

## Always Do

- **MUST run impact analysis before editing any symbol.** Before modifying a function, class, or method, run `impact({target: "symbolName", direction: "upstream"})` and report the blast radius (direct callers, affected processes, risk level) to the user.
- **MUST run `detect_changes()` before committing** to verify your changes only affect expected symbols and execution flows. For regression review, compare against the default branch: `detect_changes({scope: "compare", base_ref: "master"})`.
- **MUST warn the user** if impact analysis returns HIGH or CRITICAL risk before proceeding with edits.
- When exploring unfamiliar code, use `query({search_query: "concept"})` to find execution flows instead of grepping. It returns process-grouped results ranked by relevance.
- When you need full context on a specific symbol — callers, callees, which execution flows it participates in — use `context({name: "symbolName"})`.
- For security review, `explain({target: "fileOrSymbol"})` lists taint findings (source→sink flows; needs `analyze --pdg`).

## Never Do

- NEVER edit a function, class, or method without first running `impact` on it.
- NEVER ignore HIGH or CRITICAL risk warnings from impact analysis.
- NEVER rename symbols with find-and-replace — use `rename` which understands the call graph.
- NEVER commit changes without running `detect_changes()` to check affected scope.

## Resources

| Resource | Use for |
|----------|---------|
| `gitnexus://repo/cogpit/context` | Codebase overview, check index freshness |
| `gitnexus://repo/cogpit/clusters` | All functional areas |
| `gitnexus://repo/cogpit/processes` | All execution flows |
| `gitnexus://repo/cogpit/process/{name}` | Step-by-step execution trace |

## CLI

| Task | Read this skill file |
|------|---------------------|
| Understand architecture / "How does X work?" | `.claude/skills/gitnexus/gitnexus-exploring/SKILL.md` |
| Blast radius / "What breaks if I change X?" | `.claude/skills/gitnexus/gitnexus-impact-analysis/SKILL.md` |
| Trace bugs / "Why is X failing?" | `.claude/skills/gitnexus/gitnexus-debugging/SKILL.md` |
| Rename / extract / split / refactor | `.claude/skills/gitnexus/gitnexus-refactoring/SKILL.md` |
| Tools, resources, schema reference | `.claude/skills/gitnexus/gitnexus-guide/SKILL.md` |
| Index, status, clean, wiki CLI commands | `.claude/skills/gitnexus/gitnexus-cli/SKILL.md` |

<!-- gitnexus:end -->
