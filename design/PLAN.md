# Development workflow upgrades

Approved by the user on 2026-10-29 in session `01a1891c-89ca-78a1-8495-a51992102e21`: implement all nine recommendations below. Keep this list as the implementation reference. Use one Opus 5.5 session at high effort for the hard packages and GPT 6.1 sessions at high effort for the others.

Application baseline: `f2f4c21f`. Implementation branches start at `6567fc30`, which removed the previous comparison documents. This plan records the newly approved work and does not restore those documents. The source review used upstream T3 Code commit `08a463e29976617134de01e9341f898bc881d0eb`; expected performance benefits must be verified rather than presented as measured speedups.

## Approved reference list

| Item | Improvement | Required outcome |
| --- | --- | --- |
| 1 | Diff and syntax highlighting workers | Expensive diff computation and tokenization leave the UI thread; shared bounded caches, cancellation and idle cleanup preserve responsive large-file review. |
| 2 | Heavy tool output on demand | Collapsed tool rows carry lightweight metadata; expanding retrieves authorized result bodies. Live output is subscribed to only while needed. Native history and older clients remain usable. |
| 3 | Incremental streaming Markdown | Reuse safely completed parsed prefixes while streaming, with full-parse fallbacks for document-wide syntax and compatible GFM rendering. |
| 4 | Inspectable context chips | File excerpts, terminal selections, browser annotations and quoted assistant replies have typed, removable, inspectable context; quotes retain source navigation and a readable saved snapshot. |
| 5 | Worktree setup recipes and progress | User-configured project setup commands run for new worktrees with visible stages, logs, completion/failure and cancellation. Existing native hooks remain supported. |
| 6 | Prompt stash and recall | Save and restore unfinished prompts with attachments without silent loss; recall previously sent prompts from an empty composer without stealing normal editing/suggestion navigation. |
| 7 | Opt-in usage-limit continuation | Explicitly opted-in work resumes after a valid future allowance reset; cancellation, intervening user activity, authorization changes and restart ambiguity prevent unwanted/duplicate sends. |
| 8 | Scheduled and webhook-triggered tasks | Durable recurring tasks and authenticated webhook tasks select a project/provider/workspace, expose execution history and controls, and handle duplicate deliveries and burst coalescing. |
| 9 | PR review workspace | Review changed files and draft inline comments in the existing GitHub workflow, start an agent in a PR worktree, and provide optional generated review guides. External writes require an explicit user action. |

## Current delivery scope

The user explicitly reaffirmed **Complete all nine** on 2026-10-30 after the seven-item checkpoint. All nine implementation checkpoints are now integrated; the earlier preference to keep token spend low still applies. Reuse the existing Opus5.5/high session and shared foundations, with focused tests, synthetic QA and one bounded independent review of the remaining security-sensitive work. The release assessment follows completion; no release has been triggered.

## Packages and dependency order

| ID | Items / scope | Base | Model | Status |
| --- | --- | --- | --- | --- |
| REVIEW | Adversarial read-only plan and source review | `6567fc30` | GPT 6.1 Sol / high | Complete; findings incorporated |
| FOUNDATION | Shared trigger admission/authority and cross-package contracts | `34b0585c` | Opus 5.5 / high | Integrated with review corrections; independent original and follow-up repro checks approved |
| RENDER | 1, 3: diff/highlighting workers and streaming Markdown | `34b0585c` | GPT 6.1 Sol / high | Integrated: `96fa2530`, `69e81a01`, `bc40d802`; 116 focused tests passed |
| OUTPUT | 2: demand-loaded tool results and bounded live output | FOUNDATION checkpoint `0b5fa539` | Same Opus 5.5 / high session | Integrated as `585994e1`, parity correction `f0bdc421`; copy and multipart/status corrections integrated; supplied-fix rechecks approved |
| WORKTREE | 5: setup recipes, lifecycle and progress | `34b0585c` | GPT 6.1 Sol / high | Integrated as `f8359463`; shared startup review corrections approved |
| RECOVERY | 7: opt-in allowance-reset continuation | FOUNDATION integrated `c59ab6ac` | GPT 6.1 Sol / high | Integrated with review correction `c8b90671`; independent recheck approved |
| CONTEXT | 4: typed composer context and citations | OUTPUT integrated | Same Opus 5.5 / high session | Integrated with corrections `4e699654`, `b121df11`, `9f27f3da`; full-app QA passed; draft-boundary corrections included with STASH `d5c59426` |
| STASH | 6: stash, attachment restoration and prompt recall | CONTEXT integrated `c6cabe8a` | GPT 6.1 Sol / high | Integrated as `d5c59426`; full-app QA passed |
| AUTOMATION | 8: durable schedules, webhooks and history | FOUNDATION, RECOVERY and WORKTREE integrated | Same Opus 5.5 / high session | Integrated `2e081612`, corrections `42f2e6aa` / `4e1c7d15`; independent exact-case recheck approved |
| REVIEW-UI | 9: PR review, local drafts, worktree action and guides | CONTEXT, WORKTREE and RENDER integrated; plugin contracts ready | Same Opus 5.5 / high session | Integrated as `aabfd7db`; correction `ccccecd2` persists immutable submissions, pins bases and keeps blocked guides cancellable |
| VERIFY | Independent review, full gates and real-browser QA | All packages integrated | GPT 6.1 Sol / high | All-nine private suite: 773 files / 11,926 tests passed; follow-up corrections focused-tested; final CI tracked in PR #20 |

The Opus worker implements FOUNDATION, OUTPUT, CONTEXT, AUTOMATION and REVIEW-UI sequentially and reports a separate commit for each. Other workers own distinct worktrees and bounded file areas. Opus is the sole writer of shared scheduling/storage/authority contracts; the lead reviews and integrates those contracts, shared configuration edits and final verification. No worker pushes, creates issues/comments/PRs, merges into the owner's checkout, deploys, sends Slack messages or changes provider credentials.

## Reviewed contract boundaries

| Boundary | Owner | Compatibility and acceptance |
| --- | --- | --- |
| Result projection v1 | OUTPUT | Opt-in lightweight records carry explicit original native cursors and bounded semantic metadata. Legacy native full/page/watch responses remain byte-compatible. Opaque references bind provider instance, root/child transcript, tool occurrence and generation; rotation/truncation/undo invalidate stale references visibly. Retrieval rechecks session access and never accepts an arbitrary path. |
| Composer envelope v1 | CONTEXT | Ordered serializable context items, attachment references, saved snapshots and stable source identities share one deterministic readable provider projection. Carry the envelope through pending/new/existing composers, optimistic/queued/refused sends, durable fingerprints and reload. Use an authorized sidecar where native formats lack metadata; preserve readable native prompts. STASH consumes this exact envelope and persists image bytes rather than File objects or blob URLs. |
| Trigger occurrence and admission | FOUNDATION | One durable occurrence record, revision and deterministic command/creation identity per due event; integrate existing dispatcher/creation receipts. Visible held/unknown states preserve uncertainty across crashes. Opus alone owns orchestration schema version 5 and its compatibility tests; siblings do not edit the migration/store. |
| Unattended execution authority | FOUNDATION | Persist owner/grant ID and revision bound to project, provider instance, workspace, permitted action and target binding. Revalidate at execution; never serialize a request/cookie or fall back to privileged local execution for an authenticated edition. Editions unable to authorize unattended work hold it for explicit reauthorization. Webhook signatures admit input, not creator privileges. |
| Setup readiness | WORKTREE | One setup operation per creation; resolve and authorize the actual native cwd and complete readiness before the first prompt. Preserve native worktree hooks, avoid duplicate setup, kill task process trees on cancellation and retain failed/dirty worktrees. Automation and PR actions await this readiness. |
| PR review host actions | REVIEW-UI | Add patch/review DTOs and narrowly permissioned host actions through existing plugin packages. Pin base/head, page beyond 100 files, represent binary/oversized/unavailable patches, and bind local drafts and guides to the head SHA. No arbitrary shell/start-session escape from a plugin. |

The focused review was performed by session `01a18984-9425-7c90-9736-97368750a796`. Its findings are implementation requirements: preserve native cursor semantics, share trigger admission/authority, consolidate draft protections, establish setup readiness, and extend the existing GitHub plugin boundary. Browser annotations include an explicit frozen-frame rectangle/note/image capture flow; DOM selectors can enrich it. Review guides use an explicit authorized generation action, saved structured stops and pinned base/head, with cancel/error/regenerate and stale-head handling.

## Integration requirements

- Preserve native transcripts, durable command IDs/receipts, session access checks, provider-instance scope, legacy clients, public-clone operation and edition boundaries.
- Define new browser-safe contracts in `shared/contracts/`; register new routes once in `server/api-routes.ts`; keep provider knowledge inside the existing agent layer.
- Do not copy upstream implementation without preserving required notices. Prefer focused implementations within the existing architecture.
- Reserve QA ports 19710–19719 for RENDER, 19720–19729 for the Opus worker, 19730–19739 for WORKTREE, 19740–19749 for RECOVERY, 19750–19759 for STASH, and 19760–19769 for final integration QA. Use isolated test storage and synthetic agents; never restart the user's Cogpit server or run real account mutations for QA.
- Existing orchestration storage is owned centrally. Workers proposing schema changes must report the migration/interface first; allocate non-overlapping migrations before editing shared storage. Do not introduce a second scheduler or command-dispatch path.
- All code changes need meaningful regression coverage. Run root Vitest and the separate `packages/cogpit-memory` suite, plus the public suite and the applicable lint, type, architecture, agent-vocabulary, sync, dependency and build gates. Diagnose baseline failures once and do not weaken gates.
- Perform browser QA for changed UI using private `tmp-*` browsers; close task browsers and processes. Keep milestone screenshots under `/dev/tmp` and show useful evidence inline.
- Before each commit, the staged diff must contain zero CR characters. Before any authorized push, check CR characters and whole-file line-ending flips against the actual trunk. Never discard someone else's uncommitted work.

## Verified seven-item checkpoint

Verified 2026-10-30. Implementation checkpoint `f75d2ccb`; the final handoff commit changes this reference only. Baseline `6567fc30` remains the public master revision that removed the old comparison documents. Nothing in this delivery restores them.

- Clean public-clone gate passed: lint, architecture, agent vocabulary, complete production/test typechecks, **672 files / 10,120 tests passed, 3 skipped**, web and Electron builds; no private-edition UI emitted.
- Public suite passed the same **10,120 tests** with two workers. Default parallelism reproduced the existing appLoading import hook timeout on this busy host; timeout/assertions were unchanged. The separate cogpit-memory suite passed **110 tests**.
- Duplicate, 25-module memory sync, skill sync, protocol and dependency-audit ratchets passed. No new dependency or baseline audit allowance was added.
- Independent rendering review approved 1,500 legacy diff comparisons, 19,458 full-GFM AST/source-position comparisons and actual worker lifecycle probes. Foundation cancellation/shutdown/startup-authority reproductions and recovery receipt/native-attachment reproductions were independently approved after correction.
- Output corrections preserve complete structured diffs and multipart text/status. Copying over the cache budget was independently verified, including a 9Mi-character suffix and explicit partial/failure notices. Synthetic initial transcript transfer fell from 1,449,550 to 30,544 bytes with identical native cursors; this is a fixture measurement, not a general app-speed claim.
- Full-app synthetic browser QA covered trusted worktree success/failure/retry/cancel, context quote/excerpt/browser-region send and reload, and stash image reload/swap/quota recovery/scoped drafts/recall. Recovery's real-server component fixture verified restart plus exactly one due send and cancellation on opt-out/new native work/pending approval.
- Final context/draft corrections include literal saved snapshots, frame/page generation captured before bitmap decoding, bounded quote-source paging, shared context budget validation, atomic refused drafts and complete rejected-paste retention. Focused browser/socket148 and stash178 tests plus final combined suites passed. Additional independent review rounds stopped at the user's cost request.
- At this seven-item checkpoint task browsers, hosts and completed worker checkouts were cleaned. The later all-nine instruction resumed the preserved automation sketches and the existing Opus session.
- The private edition package was absent at this checkpoint; it was subsequently checked out and verified in the all-nine suite. Public operation and edition-interface authorization fakes passed. `/dev/tmp` was unavailable on this host, so QA screenshots use the documented `/tmp` fallback.

Implementation references: rendering `96fa2530` / `69e81a01` / `bc40d802`; output `585994e1` / `f0bdc421` / `881c5a23` / `cd18c323`; worktree `f8359463`; foundation `c59ab6ac` / `de950c8d` / `a6392691` / `93064c7d` / `70540625` / `def02918`; context `c6cabe8a` / `4e699654` / `b121df11` / `9f27f3da`; recovery `f28eda50` / `31b207ba` / `f4becf1d` / `c8b90671`; stash `d5c59426`.

The requested model split used one Opus5.5/high session (`49aca81c-c8ef-4635-ae9b-d595b2929e95`) for the hard packages and GPT6.1Sol/high sessions for rendering, worktree setup, recovery, stash and independent checks. All were launched through Cogpit sessions under parent `01a1891c-89ca-78a1-8495-a51992102e21`. No implementation push, PR, deployment or external comment was made.

- 2026-10-30: user explicitly resumed all nine. Integration branch `feat/complete-workflow-upgrades` starts at verified checkpoint `91c7f07f`; Opus session `49aca81c-c8ef-4635-ae9b-d595b2929e95` resumed with its automation sketches preserved and seven-item code merged. GitHub latest release was `v3.5.1`; app manifest is3.5.1;3.5.3 has not been prepared or triggered. Latest master quality40940642267 has a Windows share-guest test failure to investigate before a release.

- AUTOMATION item8: worker `32315221` integrated as `2e081612`,342 focused tests and synthetic full-app QA passed. Review corrections `914a9450` / `2a39839f`, integrated as `42f2e6aa` / `4e1c7d15`, authenticate replay identity, check all prior task sessions, separate webhook coalescing and refresh live run history. A bounded independent recheck approved all four exact cases. Item9 is running.
- Private edition compatibility: commit `46f0de0` was pushed to its `fix/workflow-route-policies` branch before core pointer `c17c9182`. Worktree setup/task administration remain admin-only; result retrieval requires session access; only exact signed-hook ingress bypasses account sign-in, with owner grants still required for execution.100 focused core/private integration tests and app/server production types passed. The private commit must be merged into its main branch before the release workflow's require-merged gate can pass.
- Windows readiness: `352901d3` replaces the share-guest credential test's one-second polling race with the actual delegation callback;69 tests in the file and30 focused repetitions pass. New Windows CI is still required before a release.

## All-nine integration

The approved list is implemented on `feat/complete-workflow-upgrades`; PR `gentritbiba/cogpit#20` targets the repository default `master`, as authorized in session `01a1891c-89ca-78a1-8495-a51992102e21`. Item8 commits `2e081612`, `42f2e6aa` and `4e1c7d15` passed the independent exact-case recheck. Item9 checkpoint `aabfd7db` adds the PR review workspace. Its bounded review led to `ccccecd2`: persist immutable uncertain submission snapshots, check both base/head across drafts and submission, and keep blocked guide sessions cancellable. The worker correction suite passed 1,357 focused tests.

The private edition dependency is published as `gentritbiba/cogpit-team` commit `09c5c2de`, recorded by core `400a6151`. It adds scoped route policies, the narrow signed webhook ingress exception, and real tool-result access-matrix probes; no private source is copied into core. The private branch must merge before a release.

At `aabfd7db`, the complete private-edition suite passed **773 files / 11,926 tests, 3 skipped**; cogpit-memory passed **110 tests**. Production and test types, lint, architecture, agent vocabulary, duplicate ratchet, protocol, memory/skill sync, audit, private web/Electron builds and external plugin-package contracts passed. The final merge requires a passing clean public-clone gate and GitHub Linux/Windows jobs; their current results are tracked in PR #20. The Windows baseline polling correction `352901d3` retains the original security assertions.

Synthetic browser QA covered scheduled task creation/history, webhook coalescing, review drafts/viewed marks, Ask agent context, explicit review submission, pinned-head work sessions, saved guides, and stale-head display. No real provider or GitHub review write was used. Terminal context has unit coverage; install-review upgrade UI was not browser-tested. Release3.5.3 has not been tagged or published.

Final CI dependency: private commit `7038182` retains all route policies and runs its complete suite with two workers. Its predecessor paired run40984942354 passed11,926 tests but exhausted the existing30-minute job limit during builds. No suite, assertion or timeout was removed. PR #20 records the final hosted results.

## Optional-plugin revision — 2026-10-30

In session `01a1891c-89ca-78a1-8495-a51992102e21`, the user explicitly changed items5/6: **both Worktree setup and Saved drafts become optional installable plugins**, with no default controls in the main app. Preserve code and existing saved data; keep generic composer, failed-send safety and worktree readiness hooks needed by the remaining core features. Rename Saved prompts to Saved drafts in the optional feature. This supersedes their default built-in delivery; the other seven items remain in core.

| Package | Scope | Base | Model | Status |
| --- | --- | --- | --- | --- |
| UI | Hide worktree recipe configuration from new-session screen; compact editor dialog elsewhere | `4ebc120c` | Lead | Verified: 15 focused, normal/public10172 + memory110, types/lint/build/architecture, desktop/mobile browser QA |
| PLATFORM-REVIEW | Verify existing plugin architecture; propose minimal safe installation/lifecycle and draft bridge contracts | `4ebc120c` | Opus5.5/high via Cogpit | Complete; existing trusted host integration and lazy client adapter chosen |
| PLATFORM | Shared plugin contracts/host integration and optional Worktree setup package | Review contract | Same Opus session | Integrated through `9b2a8e66`; frame fix `299c9231` preserves navigation revocation after handshake |
| DRAFTS | Optional Saved drafts package; clean core composer, preserve legacy bytes and send-refusal safety | Shared contract | GPT6.1/high via Cogpit | Integrated as `6046eedb` from worker `c212e7dd`; 125 focused tests pass |
| VERIFY | Integrate, permission/data/disable checks, full/public/memory gates and browser QA | Both packages | Lead | Complete locally: normal12017 / public10255 + 3 skipped / memory110; types, lint, checks, web/Electron and external package contracts passed. PR #23 awaits hosted checks. |

PR `gentritbiba/cogpit#23` supersedes the default built-in delivery of items5/6 in #20; the other seven remain in core. It preserves master `26b66b82` (including voice/dictation and v3.5.2) and pins the published companion `gentritbiba/cogpit-team` commit `0926c15` from its PR #2 for the generic startup policy. Production-built synthetic browser QA verified both reviewed installs, an existing text+PNG stash with identical image bytes, disable/shortcut cleanup, retained recipes, host-owned trust confirmation, and setup in a new worktree. An absent plugin left the old recipe inactive. The default mobile composer was390px without overflow. No real provider prompt or external review write was used. Browser-detected acknowledgment and sandbox form issues were fixed in `133fff70` and `46d2d9ae`; their exact regressions pass. Worker sessions and QA hosts are stopped. No release tag was created by this task.
