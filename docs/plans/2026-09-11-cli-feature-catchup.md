# CLI compatibility audit — 2026-09-11

Cogpit now targets Claude Code 2.1.268 through Agent SDK 0.3.268 and supports the applicable additions in Codex CLI 0.154.0. These changes are local and unreleased.

## Comparison baseline and sources

The previous recorded Claude audit was [August 25, through 2.1.245](2026-08-25-claude-code-catchup-2-1-245.md), newer than the approximate one-month baseline. This audit covers 2.1.246–2.1.268. For Codex, it covers stable releases from August 11 through September 11: 0.148.0–0.154.0, including patch releases. Earlier auto-review protocol changes were also checked because they affect current integration.

Primary sources:

- [Claude Code changelog](https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md).
- [Agent SDK 0.3.268 package metadata](https://registry.npmjs.org/@anthropic-ai/claude-agent-sdk/0.3.268) and the installed package's TypeScript declarations, compared with 0.3.245.
- [Codex changelog](https://learn.chatgpt.com/docs/changelog) and release notes for [0.148](https://github.com/openai/codex/releases/tag/rust-v0.148.0), [0.149](https://github.com/openai/codex/releases/tag/rust-v0.149.0), [0.150](https://github.com/openai/codex/releases/tag/rust-v0.150.0), [0.151](https://github.com/openai/codex/releases/tag/rust-v0.151.0), [0.152](https://github.com/openai/codex/releases/tag/rust-v0.152.0), [0.153](https://github.com/openai/codex/releases/tag/rust-v0.153.0), and [0.154](https://github.com/openai/codex/releases/tag/rust-v0.154.0).
- Installed binaries: `claude --version` → 2.1.268; `codex --version` → 0.154.0. Generated Codex app-server schemas, `exec --help`, a live `model/list` request, and an ephemeral thread without a model turn provided runtime checks.

## Implemented

| Change | Cogpit behavior |
| --- | --- |
| Claude SDK update | Dependency and lockfile move from 0.3.245 to 0.3.268, including the updated bundled CLI and upstream fixes. |
| Request-specific Claude approvals | Carry `defaultToNo` and `suppressAlwaysAllowRule` through the runtime. Such requests bypass neither a saved allow rule nor the full-access shortcut. Suppressed persistent approval becomes one-time approval. |
| Approval UI | Restricted prompts focus Deny, omit approval keyboard shortcuts, and suppress batch approval. Mission Control also focuses Deny. Requests that disallow persistent permission do not offer Always allow. |
| Headless commands | Add `/advisor`, `/reload-plugins`, `/reload-skills`, `/skill-doctor`, and `/workflow-authoring` to slash suggestions. Verified all five against SDK `supportedCommands()`. Move the built-in roster into the agent layer. |
| Claude tool and hook events | Add useful Artifact and SendFeedback summaries; recognize PreModelSwitch and PostModelSwitch hook names. SendFeedback is shown as a draft. |
| Custom system-prompt snapshots | Preserve the SDK's custom prompt object and snapshot setting when appending Cogpit instructions. |
| Codex auto review | Add Auto review to the permission picker. App-server sends `approvalsReviewer: auto_review` with workspace-write and on-request approval. CLI launches use `--approve-for-me`. Other explicit modes reset the reviewer to the user. |
| Codex resume semantics | Omitted permission settings leave saved approval and sandbox policy intact on resume and subsequent turn start. New sessions still use workspace defaults unless explicitly configured. |
| Codex models | Add GPT-6 Astra to the offline fallback catalog, including its effort range and Fast tier. Default no longer claims to be Sol while catalog discovery is unavailable. The live catalog remains authoritative. |
| Codex worktrees | Enable the new-session Worktree control. A selected worktree launches native `codex exec --enable worktrees --worktree`; session discovery follows the emitted thread ID and uses its actual checkout directory. The flag is scoped to that launch. |

## Changes handled by existing integration

Claude's Fable 5.1 and per-model effort availability flow through `supportedModels()`, including existing label disambiguation. The SDK handles stream recovery, plugin reload fixes, permission checking, prompt caching, and new settings. Settings such as output limits, effort caps, subagent options, and managed MCP configuration remain CLI settings; the existing configuration editor preserves them. Artifact content still uses the generic tool-result renderer.

Codex already has async questions, live model/effort/tier discovery, goals, session management, exports, tool output and patch rendering in Cogpit. Async questions were integrated on September 8–9, before this audit. Plugin, MCP, provider, and hook configuration continues through the CLI's configuration and runtime; new OAuth refresh and plugin reload behavior comes from the installed CLI.

Terminal-specific editing, Vim motions, `/copy`, recaps, terminal dashboards, and Windows daemon management run in the CLI. Claude gateway, cloud-runner, web-app, and VS Code features are separate product surfaces. No gateway, runner, provider account, or hosted environment was provisioned for this update.

## Explicit boundaries

- Native Codex worktrees are experimental upstream. The generated stable and experimental app-server schemas expose no worktree-creation method, so the first worktree turn uses `codex exec`. It has the existing CLI fallback limitations: no app-server steering or interactive approval dialog during that initial turn. Later turns use the normal app-server path after the CLI process finishes. Native worktree forks remain available in the terminal; Cogpit's existing fork behavior is unchanged.
- Opt-in compressed Codex rollouts/shared histories are not supported by Cogpit's JSONL file readers. [Upstream compression work](https://github.com/openai/codex/pull/42039) marks this under development and disabled by default. This audit does not enable it or claim compatibility with every experimental storage flag.
- Model availability depends on the local CLI and account. The live Astra catalog and auto-review settings were verified locally; remote machines and older CLI versions were not tested.
- Claude background MCP resource links retain the CLI's textual summary; no separate structured resource-link browser was added.

## Verification

- Full root suite: 405 files, 6,364 tests passed.
- `packages/cogpit-memory`: 108 tests passed across the unaffected files and three separately executed SQLite suites. Whole-package execution and those three suites still terminate with the already documented Bun 1.4.0-canary.1 SQLite teardown segfault; there were no assertion failures.
- Production and test TypeScript checks, ESLint, architecture, agent-vocabulary, memory-sync, and duplicate-code gates passed. React Doctor reported 92/100 with one existing function-complexity warning and no errors.
- Browser QA used the real session-settings and approval components in an isolated local fixture. Checked worktree toggling, auto-review selection, model display, blocked approval shortcuts, and explicit click approval. This was not an end-to-end model conversation in the packaged app.
- A disposable Git repository and isolated `CODEX_HOME` verified native worktree creation and matching `thread.started`/rollout IDs. The provider pointed at a deliberately unreachable loopback address, so generation stayed in connection retry until the test process was stopped. No model response was tested. Temporary processes, browser, fixture source, and worktree storage were cleaned up; the [UI screenshot](../../artifacts/cli-catchup/verified.png) is retained locally.

Dependency and runtime evidence is recorded in both [the project deployment record](../../.claude/deployments.md) and [the global index](/Users/gentritbiba/project-manager/deployments.md). The installed app and remote deployments have not been updated by this work.
