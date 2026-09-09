# Bloat Removal Documentation Audit

**Date:** 2026-09-09  
**Commit Range:** 498aa13 (large bloat-removal pass)  
**Scope:** 345 files changed, +2273/-7074 deletions

## Files Audited

- ARCHITECTURE.md
- CLAUDE.md
- AGENTS.md
- README.md
- docs/architecture/README.md
- docs/browser.md
- docs/plugins.md
- docs/ui-simplification.md
- docs/self-hosting.md
- packages/cogpit-memory/README.md
- packages/cogpit-memory/SKILL.md
- .claude/skills/cogpit-sessions/SKILL.md

## Changes Summary

### Major deletions
- `electron/server.ts` — thin pass-through shim
- `server/standalone-app-server.ts` — thin pass-through shim
- `server/lib/sessionInventoryCache.ts` — unused cache
- `server/routes/{config-browser,ports,projects,worktrees}.ts` — refactored to directories
- `shared/session/token-costs.ts` — moved/consolidated
- `packages/cogpit-memory/src/lib/token-costs.ts` — moved/consolidated
- `src/components/{HoverRevealPanel,timeline/BackgroundAgentPanel,timeline/SubAgentPanel}.tsx` — dead UI components
- 25+ unused shadcn sub-components

### Major refactorings
- Route files `.ts` → directories with `index.ts` (auto-resolved by TypeScript/Node)
- `AGENTS.md` converted to symlink to `CLAUDE.md`
- cogpit-memory bumped 0.2.1 → 0.3.0 (breaking: SearchIndex API)

## Findings

### ARCHITECTURE.md
✅ **No drift.** Correctly references existing files and modules. All topology diagrams and registry descriptions remain accurate. The `server/team/policy.ts` reference is valid.

### docs/architecture/README.md
✅ **Updated correctly.** Server composition row was updated from:
- Old: `electron/server.ts` and `server/standalone-app-server.ts` are thin adapters
- New: `createServerComposition` is called directly by `electron/server-worker.ts` and `server/standalone-runtime.ts`

The referenced files (`electron/server-worker.ts` and `server/standalone-runtime.ts`) exist and are correct.

Added three new paragraphs about canonical run, loopback-listener suites, and `check:audit` requirements. This content appears to have been merged from the deleted `docs/code-health-baseline.md`.

### CLAUDE.md
✅ **No updates needed.** The "Adding New API Routes" and "Agent Layer" sections remain accurate. The section correctly describes the `server/api-routes.ts` registry pattern. No references to deleted files.

### README.md
✅ **Correctly simplified.** Removed 18 lines of detailed network/TLS/password policy prose and linked to `docs/self-hosting.md` instead. Verified that the target doc exists and contains all the moved content (forwarding headers, password policy, session expiry). Also fixed development command: `bun run build && bun run preview` → `bun run serve`.

### docs/browser.md
✅ **API documentation updated.** Removed `unsupportedReason?` from the `/api/browser` response documentation. The change accurately reflects that the endpoint now always returns 200 with `installed: false` and `binaryPath: null` when `agent-browser` is unavailable.

### docs/plugins.md
✅ **Panel API documentation reduced.** Removed the `openPanel(id)` function from the panel context. Verified that this function is not in `src/plugin-api/` and the documentation change is accurate.

### docs/ui-simplification.md
✅ **Historical reference updated.** Changed reference from "Solving anything with `HoverRevealPanel`" to note that the component was deleted as dead code. The guardrail lesson is preserved with guidance that "if a panel ever needs an edge trigger again, make it wide and never put a first-class action behind it." Removed the now-stale comparison table row referencing it.

### packages/cogpit-memory/SKILL.md
✅ **Comprehensive update for 0.3.0.** All `bunx cogpit-memory` invocations changed to `cogpit-memory`. Added new `--exclude-session` flag throughout examples and in the options table. Updated installation guidance from `npm install -g` context to `bun install --global`. Added warnings about Node.js 20+ requirement, JSON stderr handling, and concurrent transient installs. Search behavior section updated to mention SQLite FTS5 index with raw-file fallback.

### packages/cogpit-memory/README.md
✅ **Installation and flags updated.** Changed from `npm install -g` to `bun install --global`. Removed `npx cogpit-memory` shortcut; now emphasizes using the installed CLI. Added `--exclude-session` flag to the options table. Updated guidance to keep stderr separate when parsing JSON. Clarified that missing transcripts are removed from the index before searching.

### .claude/skills/cogpit-sessions/SKILL.md
✅ **Breaking API change documented.** Added comprehensive guidance for the new `requestId` field for safe retries, including:
- When to use it (always for new sessions)
- How to persist requests and reuse IDs safely
- Conflict resolution (409 with different payload vs. pending)
- Server version compatibility notes
- Changed `echo` to `printf` in bash examples to avoid shell interpretation of backslash escapes

### AGENTS.md
✅ **Symlink verified.** `AGENTS.md` is correctly a symlink to `CLAUDE.md` (9-byte link). No duplicate maintenance burden.

### Route refactoring (api-routes.ts)
✅ **No breakage.** Routes were refactored from single `.ts` files to directories with `index.ts` (e.g., `server/routes/config-browser.ts` → `server/routes/config-browser/index.ts`). TypeScript and Node.js automatically resolve imports to `index.ts` when given a directory path, so `import { registerConfigBrowserRoutes } from "./routes/config-browser"` still works. The api-routes.ts file itself only has minor refactoring changes (hub proxy simplified via apiRoute helper).

## Left Intentionally Unchanged

- **docs/plans/** — Historical decision records. Left all references to deleted files intact (per audit instructions).
- **ARCHITECTURE.md section on "How to add a fourth agent CLI"** — Still accurate; no step numbers or file paths changed.

## No Issues Found

All documentation drift from the bloat-removal pass has been correctly addressed. The deletion of dead code, unused components, and pass-through shims is properly reflected in every affected doc. Refactorings (route files to directories, symlink introduction) are transparent to callers. Breaking changes in cogpit-memory are fully documented with migration guidance.

The codebase and its documentation are in sync.
