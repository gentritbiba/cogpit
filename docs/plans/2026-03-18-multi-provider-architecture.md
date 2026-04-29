# Multi-Provider Architecture Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Refactor Cogpit to support Claude Code and Codex (and future providers) through a clean provider abstraction layer, eliminating all if/else branching scattered across 15+ files.

**Architecture:** Each provider (claude, codex, future) implements a `SessionProvider` interface that handles CLI spawning, argument building, session discovery, JSONL parsing, and metadata extraction. A central registry maps `AgentKind` to the correct provider. All shared utilities live in a single `src/lib/providers/` directory that both the client, server, and cogpit-memory package import from.

**Tech Stack:** TypeScript, Node.js, React, Vitest

---

## Phase 1: Fix Broken Tests and Stabilize (Prerequisite)

### Task 1.1: Fix undo route test mocks

**Files:**
- Modify: `server/__tests__/routes/undo.test.ts:6-23`

**Step 1: Update the helpers mock to include missing functions**

The undo routes now import `resolveSessionFilePath` and `isCodexDirName` from helpers. The test mock is missing both.

Add to the mock object:

```typescript
isCodexDirName: vi.fn(() => false),
resolveSessionFilePath: vi.fn((_dirName: string, fileName: string) =>
  `/tmp/test-projects/proj/${fileName}`
),
```

Add the import and mock variable:

```typescript
import { isCodexDirName, resolveSessionFilePath } from "../../helpers"
const mockedResolveSessionFilePath = vi.mocked(resolveSessionFilePath)
const mockedIsCodexDirName = vi.mocked(isCodexDirName)
```

**Step 2: Update the truncate-jsonl "rejects paths outside" test**

Mock `resolveSessionFilePath` to return `null` for rejection cases, and return a valid path for success cases. Update all truncate-jsonl and append-jsonl tests that validate path security or successful operations.

**Step 3: Run tests to verify**

Run: `bun run test -- server/__tests__/routes/undo.test.ts`
Expected: All 24 tests PASS

**Step 4: Commit**

---

## Phase 2: Extract Shared Provider Utilities

### Task 2.1: Create the shared provider types module

**Files:**
- Create: `src/lib/providers/types.ts`
- Create: `src/lib/providers/__tests__/types.test.ts`

Define: `AgentKind`, `AGENT_KINDS`, `SessionMetadata`, `SessionStorageConfig`, `CliArgBuilders`, `SessionProvider` interface.

### Task 2.2: Extract Codex provider implementation

**Files:**
- Create: `src/lib/providers/codex.ts`
- Create: `src/lib/providers/__tests__/codex.test.ts`

Move from `server/helpers.ts` and `src/lib/sessionSource.ts`: `buildCodexPermArgs`, `buildCodexModelArgs`, `buildCodexEffortArgs`, `encodeCodexDirName`, `decodeCodexDirName`, `isCodexDirName`.
Move from `src/lib/codex.ts`: `isCodexSessionText`, `extractCodexMetadataFromLines`, metadata extraction helpers.

### Task 2.3: Extract Claude provider implementation

**Files:**
- Create: `src/lib/providers/claude.ts`
- Create: `src/lib/providers/__tests__/claude.test.ts`

Move from `server/helpers.ts`: `buildPermArgs`.
Implements `isSessionText` (returns true when NOT codex format), `extractMetadata` (from sessionMetadata.ts logic), `resumeCommand`.

### Task 2.4: Create the provider registry

**Files:**
- Create: `src/lib/providers/registry.ts`
- Create: `src/lib/providers/__tests__/registry.test.ts`

Functions: `getProvider(kind)`, `inferAgentKind(dirName)`, `getProviderForDirName(dirName)`, `getProviderForSessionText(jsonlText)`.

### Task 2.5: Create the barrel export

**Files:**
- Create: `src/lib/providers/index.ts`

Re-exports all types and functions from the provider modules.

---

## Phase 3: Migrate Consumers to Provider Registry

### Task 3.1: Migrate `src/lib/sessionSource.ts` to re-export from providers

Replace inline implementations with re-exports. Keep same export names for backwards compatibility.

### Task 3.2: Migrate `server/helpers.ts` to delegate to providers

Replace inline codex/claude utility functions with delegating wrappers. Remove ~80 lines of duplicated code. All existing imports continue to work.

### Task 3.3: Deduplicate `buildStreamMessage` and constants

**Files:**
- Create: `server/lib/streamMessage.ts`
- Modify: `server/routes/claude-new/sessionSpawner.ts`
- Modify: `server/routes/claude.ts`

Extract `ALLOWED_IMAGE_TYPES`, `CODEX_IMAGE_ONLY_PROMPT`, `buildClaudeStreamMessage` into shared module. Both route files import instead of defining locally.

### Task 3.4: Migrate cogpit-memory codex.ts to use shared source

Either import from providers or update sync script to generate from single source. The metadata extraction logic should live in ONE place (`src/lib/providers/codex.ts`).

---

## Phase 4: Refactor Route Handlers (Strategy Pattern)

### Task 4.1: Extract session spawning into provider-specific functions

**Files:**
- Create: `server/lib/spawnStrategies.ts`
- Modify: `server/routes/claude-new/sessionSpawner.ts`

Extract codex/claude spawn logic into `handleCodexCreateAndSend` and `handleClaudeCreateAndSend`. Each becomes ~50 lines instead of ~150 inline.

### Task 4.2: Extract send-message strategies

**Files:**
- Modify: `server/routes/claude.ts`

Extract `handleCodexSendMessage` and `handleClaudeSendMessage` from the monolithic handler.

### Task 4.3: Unify truncation line finding

**Files:**
- Modify: `server/routes/claude-new/sessionBranching.ts`

Unify `findTruncationLine` and `findCodexTruncationLine` with a `isTurnBoundary` predicate parameter:

```typescript
function findTruncationLine(
  lines: string[],
  targetTurnIndex: number,
  isTurnBoundary: (obj: Record<string, unknown>) => boolean
): number | null
```

### Task 4.4: Document session status derivation approach

**Files:**
- Modify: `src/lib/sessionStatus.ts`

Already auto-detects format from first message. Add JSDoc comments explaining the dispatch. Consider moving codex logic into provider module if more providers are added later.

---

## Phase 5: Clean Up Type Safety

### Task 5.1: Improve rawMessages typing

The `rawMessages` field was widened from `RawMessage[]` to `Array<{ type: string; [key: string]: unknown }>`. Options:
- Use `RawMessage[] | CodexRecord[]` union
- Keep widened type but document why
- Add `agentKind` to ParsedSession to disambiguate consumers

### Task 5.2: Remove redundant `source` field from PersistentSession

**Files:** `server/helpers.ts:447`

Remove `source?: "claude" | "codex"` — it duplicates `agentKind: AgentKind`.

---

## Phase 6: Add Missing Test Coverage

### Task 6.1: Add codex parser unit tests

**Files:** Create `src/lib/__tests__/codex.test.ts`

Test `parseCodexSession`, `isCodexSessionText`, `extractCodexMetadataFromLines` with fixture data: simple session, multi-turn with tools, reasoning, token usage, branched sessions.

### Task 6.2: Add codex session status tests

Test `deriveCodexSessionStatus` for: task_complete, task_started, function_call, assistant message, idle.

### Task 6.3: Add provider integration tests

**Files:** Create `src/lib/providers/__tests__/integration.test.ts`

End-to-end: given JSONL text, auto-detect provider, parse, extract metadata — for both formats.

---

## Execution Order

1. **Phase 1** — Fix broken tests (prerequisite)
2. **Phase 2** — Build provider abstraction layer
3. **Phase 3** — Wire existing code to delegate to providers
4. **Phase 4** — Refactor route handlers to use strategies
5. **Phase 5** — Type safety cleanup
6. **Phase 6** — Test coverage

## Verification

After each phase: `bun run test && bun run build` must both pass.
