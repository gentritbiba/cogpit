# Code health baseline — 2026-07-21

This audit established a measurable baseline before large-scale restructuring.
The current state below was re-verified on 2026-07-21 after the restructuring
work; the original measurements remain as the regression reference.

## Current verified state

| Area | Current result |
| --- | --- |
| Production and test TypeScript | zero diagnostics across renderer, server, Electron, tests, and `cogpit-memory` |
| Architecture | 441 production files / 1,488 local edges / zero cycles / zero legacy cross-layer exceptions |
| Duplicate code | 728 lines / 1.11% / 80 clones; all three values are CI ratchets |
| Canonical runtime suite | 180 files / 2,600 passing tests / zero skips or failures |
| Canonical coverage | 73.53% statements / 67.50% branches / 74.93% functions / 75.95% lines |
| `cogpit-memory` | 82 tests plus standalone, npm, public API, and CLI contract builds |
| Platform builds | web and Electron production compilation pass |

The canonical run includes the real loopback-listener integration suites in
`app-server.test.ts` and `hub/proxy.test.ts`. A restricted sandbox must not turn
`listen EPERM` into skipped tests or weaken their assertions; portable results
may aid diagnosis but never replace the canonical gate.

## What is healthy

- Strict TypeScript is configured for renderer, server, Electron, and `cogpit-memory`.
- The root runtime suite characterizes 2,600 cases, including the real-socket integration cases, with no warnings, skips, or failures. `cogpit-memory` has 82 passing tests.
- Electron already isolates server work in a utility process and uses a narrow context bridge.
- Session parsing has substantial characterization coverage, including provider-specific cases.
- The API route surface is now composed from one 36-module manifest across Vite, Electron, and standalone modes.
- The only indexed circular import was removed.

## Baseline debt

| Area | Baseline | Desired ratchet |
| --- | ---: | --- |
| Production TypeScript | root command previously checked 0 files; 42 real diagnostics | zero; now enforced by `bun run typecheck` |
| Test TypeScript | 468 historical diagnostics | zero; enforced separately by `bun run typecheck:tests` |
| Duplicate code | 2,604 lines / 3.68% / 88 clones | decrease on every architectural slice |
| Root tests | 117 React `act` warnings in a passing run | zero warnings |
| Circular imports | 1 | zero |
| Dependency audit | 82 findings: 1 critical, 26 high, 49 moderate, 6 low | no known critical/high exploitable path |
| React architecture | `App` ~1,600 lines; several render-time ref writes and giant components | thin composition root; pure render; feature-owned hooks/components |
| Server architecture | `helpers.ts` ~600 lines / ~40 exports / ~50 importers | focused modules with a temporary compatibility facade |
| Session engine | app and CLI carry synchronized copies | one governed shared package |
| CI | release-only; latest Bun; non-frozen install | pinned, frozen PR quality workflow |

## Review-ready gates

The repository is review-ready only when all of these are green and warning output has been inspected:

```sh
bun install --frozen-lockfile
bun run lint
bun run check:architecture
bun run check:duplicates
bun run check:cogpit-memory-sync
bun run check:audit
bun run typecheck
bun run typecheck:tests
bun run test:coverage
bun run build:web
bun run electron:build
(cd packages/cogpit-memory && bun test && bun run build && bun run build:npm && node scripts/test-package-contract.mjs)
```

`check:audit` requires access to the package advisory service. Its allow-list is
package-, advisory-, and maximum-severity-specific, rejects critical/high
findings, and also fails when an allowance becomes stale. CI runs the live gate
after frozen dependency installation.

Security-sensitive server changes additionally require local/remote authentication, same-origin mutation, WebSocket upgrade, DNS-rebinding, and shutdown behavior tests. Parser or contract changes require app and packaged-CLI consumer tests against the same fixtures.

## Definition of “10/10”

“10/10” is not a claim that the code will never need improvement. It means the dependency direction is mechanically enforced, public behavior is characterized, strict type gates cover every shipped surface, duplication has a named owner and removal path, CI reproduces release checks, high-severity security findings are resolved, and the largest modules can be changed through small feature boundaries rather than broad edits.
