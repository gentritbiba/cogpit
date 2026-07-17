# Audit: Cleanup, Power Diagnostics, and Session Reliability (2026-07-17)

**Commit ID:** PLACEHOLDER
**Scope:** Complete working-tree diff (110 tracked files plus 14 related untracked files)

## Implementation Summary

- Added an in-app Power & Activity Monitor backed by `GET /api/performance` and an Electron `performance:get-snapshot` IPC bridge.
- Added a global Codex subagent browser (`GET /api/codex-subagents`) and an always-available agent context bar with transcript navigation.
- Fixed live-session snapshot/watch races with byte-offset replay and fixed Claude `AskUserQuestion` answers to resolve the blocked SDK tool call directly.
- Added active-session Ultracode application, absolute-path project startup, Codex image restoration, readable Bash/Codex exec cards, and Codex child-agent file-change attribution.
- Reduced idle/runtime work through hidden-window throttling, slower/visibility-aware polling, watcher lifecycle cleanup, removal of permanent pulse animations, lazy terminal loading, and safer vendor chunking.
- Removed dead components and package analytics, broke import cycles, tightened types/configuration, and simplified `cogpit-memory` internals without changing its documented CLI surface.

## Documentation Reviewed

- `README.md`
- `ARCHITECTURE.md`
- `CLAUDE.md` and the new `AGENTS.md`
- `packages/cogpit-memory/README.md`
- `packages/cogpit-memory/skill/SKILL.md`
- Current audit history and the complete staged/unstaged/untracked change inventory

## Documentation Impact

**Verdict: PASS — product and architecture documentation now cover the new behavior.**

### Updates Applied

1. Added `GET /api/performance` and `GET /api/codex-subagents` to the `ARCHITECTURE.md` API route table.
2. Documented server activity sampling, Electron process-metric IPC, and open-dialog-only Power Monitor polling.
3. Added a README feature entry for the user-visible Power & Activity Monitor.
4. Documented the global Codex subagent browser and session-level agent context bar.
5. Clarified that Ultracode can be applied to active capable Claude sessions.

No public endpoint was removed and the existing request formats remain backward compatible.

## No Update Required

- `cogpit-memory` command names, flags, output layers, and installation workflow are unchanged; its README and shipped skill remain accurate for this diff.
- The offset-aware SSE replay, SDK question resolution, Codex resume change, watcher/poller reductions, lazy imports, type-only changes, and dead-code removals are internal or corrective behavior already covered by existing feature descriptions.
- `CLAUDE.md` and `AGENTS.md` consistently reference the generated GitNexus guide layout and include a bootstrap fallback.

## Existing Documentation Debt

`README.md` and `ARCHITECTURE.md` still list Radix UI in the tech stack while the application uses Base UI. This predates the audited behavior changes and remains a non-blocking follow-up.

## Conclusion

The implementation is backward compatible, and its new routes and visible workflows are now represented in the product and architecture documentation.
