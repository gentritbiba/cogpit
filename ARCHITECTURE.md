# Cogpit architecture — the agent layer

Cogpit drives three agent CLIs: Claude Code, Codex and GitHub Copilot CLI. This
document describes how the product stays one product instead of three, and how a
fourth CLI is added.

The broader dependency rules — runtime layers, package boundaries, release
gates — live in [`docs/architecture/README.md`](docs/architecture/README.md).

## The rule

> New agent-specific knowledge belongs in the agent layer.

Callers should ask the layer a question such as "what can this session do?",
"where does its transcript live?" or "send this message". Existing references
outside the layer are tracked as migration debt. `bun run check:agents` prevents
that vocabulary from growing and requires its budget to shrink as references
are removed. See [Enforcement](#enforcement).

## Vocabulary

The word *provider* is overloaded in this repo (`providerUpdates`, React context
providers). The agent layer uses **agent**:

| Term | What it is | Where it lives |
| --- | --- | --- |
| `AgentKind` | `"claude" \| "codex" \| "copilot"` | `shared/session/types.ts` |
| `AgentDescriptor` | Frozen data: dirName codecs, file naming, resume argv, launch flags, CLI install facts, config layout, context window, capabilities | `shared/session/agent-descriptors.ts` |
| `AgentFormat` | Pure transcript grammar: detect, parse, append, status, metadata, turn boundaries | `shared/session/agents.ts` + one module per agent |
| `AgentStore` | On-disk session storage (`node:fs`) | `server/agents/*Store.ts` |
| `AgentRuntime` | The live CLI process or RPC connection | `server/agents/*Runtime.ts` |

The descriptor is the table; the other three are the behaviours. A capability is
always named as a capability — `capabilities.worktrees`, never `kind === "claude"`.

## Layer rules

1. `shared/` contains **zero** `node:` imports. The renderer bundles it, so
   anything touching the filesystem is an `AgentStore` and belongs in `server/`.
2. `server/` never imports `src/`. `packages/` may only import `packages/`.
3. `scripts/sync-cogpit-memory.ts` **byte-copies** its listed
   `shared/session/` modules into
   `packages/cogpit-memory/src/lib/`. Editing the copy is a CI failure; run
   `bun run sync-cogpit-memory` after touching the originals. That package cannot
   import `server/`, so it keeps its own thin `node:fs` walker
   (`packages/cogpit-memory/src/lib/stores.ts`) — the *walking* is duplicated,
   the *knowledge* is not.
4. `scripts/check-architecture.ts` counts `import type` as a real graph edge and
   runs Tarjan. The import graph must stay acyclic.

## Cycle-safe topology inside `shared/session/`

```text
types.ts                                    ← leaf: AgentKind, AGENT_KINDS, SessionStatus
  ↑
turnBuilder · sessionStats · turnContent · messageTypeGuards
codex-patches · codex-tool-normalization · codex-exec · agentEnvelope
agent-descriptors.ts                        ← imports only ./types
  ↑
claude.ts · codex.ts · copilot.ts           ← AgentFormat impls; MUST NOT import agents.ts
  ↑
agents.ts                                   ← the registry (imports the three impls)
  ↑
parser.ts · sessionStatus.ts · interactiveState.ts · edit-calls.ts · toolSummary.ts
```

Two properties keep this a DAG:

- **`AGENT_KINDS` lives in the leaf**, so an implementation can read the
  detection order without importing the registry that dispatches on it.
- **`agent-descriptors.ts` is parser-free.** It imports `./types` and nothing
  else, so a caller that only needs a dirName codec does not drag 40 KB of
  transcript parsers along with it.

Detection order is explicit rather than accidental: `AGENT_KINDS` is
`["codex", "copilot", "claude"]`. Codex and Copilot carry positive
discriminators; Claude is the terminal arm and its `detectsText` returns `true`
unconditionally. The *order* is the contract, so no implementation has to know
about its siblings.

## Registries

Each concern has one registry. Each is a frozen `Record<AgentKind, T>` read
through functions, with no service locator or DI container. Each also exposes a `createXRegistry(table)`
factory so a test can substitute a fake instead of mocking module paths.

| Registry | Resolvers |
| --- | --- |
| `shared/session/agents.ts` | `formatFor(kind)`, `formatForText(jsonl)`, `formatForRecords(records)` |
| `shared/session/agent-descriptors.ts` | `descriptorFor(kind)`, `descriptorForDirName(dirName)`, `allDescriptors()` |
| `server/agents/index.ts` | `storeFor(kind)`, `storeForPath(filePath)`, `storeForDirName(dirName)` |
| `server/agents/runtimes.ts` | `runtimeFor(kind)`, `runtimeForDirName()`, `runtimeForSession()`, `resolveSessionAgent()` |
| `src/lib/agents/` | re-exports the shared registry, plus the presentation (icons are React and cannot live in `shared/`) |

Runtimes are deliberately kept out of `server/agents/index.ts`: the stores there
are leaves, while the runtimes reach back into `../sessionPaths` and
`./codexExecution`, which read the store registry. Routes import stores from
`./index` and runtimes from `./runtimes`.

### Which agent is this session?

`dirName` **wins** over content sniffing. It is known before a byte is read, it
is what the URL carries, and it is what every write path (spawn, undo, branch)
already keys on. `ParsedSession.agentKind` is the parser's own finding: it
cross-checks, it never overrides. `parseSessionAppend` dispatches on raw-record
shape rather than `agentKind`, because `agentKind` is optional on
`ParsedSession` and a lookup would throw on the append hot path.

## Enforcement

`bun run check:agents` (wired into `.github/workflows/quality.yml`) splits the
repo in two. It counts lines that name Claude, Codex or Copilot. It does not
attempt to interpret whether a line contains a branch:

- **The owned zone** may name an agent freely — that is its job:
  `server/agents/**`, `src/lib/agents/**`, the `shared/session/` agent modules
  and their generated cogpit-memory copies, plus the two endpoints that exist
  only to expose one CLI's own protocol.
- **Everywhere else** carries a per-file budget in
  `scripts/agent-vocabulary.json`. Exceeding it fails. Coming in *under* it also
  fails, naming the new number — that ratchet is what stops the vocabulary
  leaking back once a domain is clean. Delete the entry when a file reaches zero.

Detection is a case-insensitive substring, deliberately: a word-boundary regex
misses `codexAppServer`, `isCodexDirName` and `CopilotRuntime`, i.e. most real
call sites. Comments count too — prose naming a CLI is how the knowledge leaks
back in.

Re-seed after a cleanup with `bun scripts/check-agents.ts --write`.

## How to add a fourth agent CLI

Every step below is additive. If you find yourself editing a file outside the
owned zone, that file is the bug, not the plan.

1. **`shared/session/types.ts`** — add the kind to `AgentKind` and to
   `AGENT_KINDS`, before `"claude"` (it must stay the terminal arm).
2. **`shared/session/agent-descriptors.ts`** — add one `AgentDescriptor`: how it
   names project directories and session files, its resume command and argv, its
   `launchArgs`, where its CLI and config live, its context window, and one value
   for every capability flag. Adding the entry is what makes the compiler point
   at anything still missing.
3. **`shared/session/<agent>.ts`** — implement `AgentFormat` and register it in
   `agents.ts`. It must not import `agents.ts` back.
4. **`scripts/sync-cogpit-memory.ts`** — add the new module to `FILES` (the list
   stays explicit: auto-discovery would sweep tests into the published package),
   then run `bun run sync-cogpit-memory`.
5. **`server/agents/<agent>Store.ts`** — implement `AgentStore` over the CLI's
   sessions root, using the shared containment primitive in `./containment`.
   Register it in `server/agents/index.ts`.
6. **`server/agents/<agent>Runtime.ts`** — implement `AgentRuntime` over whatever
   transport the CLI speaks, with the transport itself as a sibling module in the
   same directory. Register it in `server/agents/runtimes.ts`.
7. **`src/lib/agents/presentation.ts`** — icon, labels, chart colour, display
   order.
8. **Containment and gates** — add the CLI name and owned module patterns to
   `scripts/check-agents.ts`, update the vocabulary budget, then run `bun run typecheck && bun run test && bun run check:architecture
   && bun run check:cogpit-memory-sync && bun run lint && bun run
   check:duplicates && bun run check:agents`.

New code should not add a fourth name-based arm to routes, hooks, components,
the session list, undo, notifications, cost accounting or the config browser.
Prefer a capability or descriptor field. Some of these areas still contain
budgeted references from before the agent layer; migrate those references when
they block the new CLI.
