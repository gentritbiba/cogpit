# CLI compatibility audit, September 14, 2026

Status: implemented and verified; unreleased. The user authorized implementation after the research review. The comparison baseline is the local September 11 audit, `docs/plans/2026-09-11-cli-feature-catchup.md`, which belongs to separate uncommitted work.

## Version baseline

| Component | September 11 | September 14 |
| --- | --- | --- |
| Installed Claude Code | 2.1.268 | 2.1.270 |
| Repository and installed Agent SDK | 0.3.268 | 0.3.270 |
| Installed/latest stable Codex CLI | 0.154.0 | 0.154.0 |

CLI versions, package metadata and official release documentation were checked on September 14. The SDK dependency was updated with Bun. No installed CLI, shared application process or remote host was upgraded by this task.

## Research findings

Claude's core assistant text, partial streaming and result envelopes remain compatible. Distinct message IDs can share a `user_message_uuid`; a regression test verifies that streamed and completed replies remain separate without duplicating final text.

Claude 2.1.269 added headless `/output-style` and fixed resumed replies, background status, goal retries, permission-denial reporting and managed-plugin behavior. Version 2.1.270 fixed the unexpected Git permission prompts introduced in 2.1.269. The current tool-result schema also exposes staged Edit/Write operations and structured Bash file diffs. These metadata fields affect how Cogpit describes changes even though ordinary text output has not been replaced.

Sources: [Claude changelog](https://code.claude.com/docs/en/changelog), [headless operation](https://code.claude.com/docs/en/headless), [output styles](https://code.claude.com/docs/en/output-styles), [Agent SDK 0.3.270 declarations](https://unpkg.com/@anthropic-ai/claude-agent-sdk@0.3.270/sdk.d.ts), [tool declarations](https://unpkg.com/@anthropic-ai/claude-agent-sdk@0.3.270/sdk-tools.d.ts), and [Codex changelog](https://learn.chatgpt.com/docs/changelog).

## Implemented behavior

- Agent SDK is pinned to 0.3.270, and `/output-style` is included in headless command suggestions. The commit includes custom system-prompt handling required by the new SDK type contract, preserving text, array and snapshot settings.
- Edit/Write results with `staged: true` display **Awaiting review**, preserve the result explanation and remain visible in grouped activity. They are excluded from applied-file changes, Mission Control change totals, archive operations and undo.
- Bash metadata supplies file paths and unified hunks independently of stdout. Cogpit validates the metadata, renders each returned file diff, and uses the hunks for file-change views and summaries. An omitted-file count is displayed when provided. Older transcripts retain command-based extraction when structured metadata is absent.
- Shared parsing is synchronized into `cogpit-memory`. Bash-derived edits remain display-only synthesized calls and cannot be automatically undone from partial hunks.

No additional Codex integration changes were needed for the September 14 delta. The other September 11 changes remain separate and unreleased. To keep this commit independent, `/output-style` is added to the existing command list; the pending command-module refactor remains in the main working tree.

## Runtime evidence and limits

Two isolated SDK 0.3.270 / Claude Code 2.1.270 probes completed exact Bash edits and normal final replies. The disposable Git fixture emitted this structure (path and content shortened):

```json
{
  "tool_use_result": {
    "bashEditDiff": {
      "files": [{
        "filePath": "/temporary-fixture/sample.txt",
        "hunks": [{
          "oldStart": 1, "oldLines": 1,
          "newStart": 1, "newLines": 1,
          "lines": ["-after", "+final"]
        }]
      }],
      "moreFiles": 0,
      "changedFiles": ["/temporary-fixture/sample.txt"]
    }
  }
}
```

The SDK envelope uses `tool_use_result`; stored Claude JSONL uses `toolUseResult`. Ordinary tool-result text contained no diff. A non-Git/default-permission fixture emitted no diff despite reporting the feature enabled; consumers must tolerate missing metadata. Omitted files cannot be reconstructed from the supplied hunks. Each unmerged file result retains its supplied addition/deletion counts, including repeated or opposing hunks and blank lines. Combined before/after strings contain only returned snippets; later overlapping operations use the existing net-diff reconstruction rather than full positional file reconstruction.

Staged edits were verified using the published schema, parser/route/summary/undo tests and real React components with synthetic records. A live owner-review staging workflow was not exercised. The running installed app, remote hosts and provider account identity were not reverified. API-reported probe costs and dependency/runtime details are recorded in [.claude/deployments.md](../../.claude/deployments.md); these are not verified invoices.

## Validation

- `bun run test`: **6,712 tests passed across 418 files** on the full working tree, including concurrent unrelated changes.
- Memory package: **108 assertions passed**. The whole-package run hit the documented Bun 1.4.0-canary.1 SQLite teardown crash. The remaining six files passed together (58 tests); `index-cmd`, `search` and `search-index` passed separately (10, 29 and 11 tests), then hit the same teardown crash.
- Production and test typechecks, ESLint, architecture, agent vocabulary, duplicate ratchet, shared-memory synchronization and `git diff --check` passed.
- React Doctor: 84/100, six component-complexity warnings across the broader working tree, no errors.
- Desktop (1150px) and mobile (390px) browser verification: two review badges, one completed Bash call, only the applied Bash file in change totals, zero reversible operations, preserved hunk coordinates and omitted-file notice, no page overflow.

Screenshots and validation logs are retained under `artifacts/cli270-qa/`. The task browser and Vite server were closed; port 19597 was verified closed. Disposable runtime data and fixture source were removed. Both deployment registries were updated. The original implementation was verified without a release or deployment. The subsequent commit verification is recorded below.

## Isolated commit verification

The commit includes only this compatibility work and the custom system-prompt prerequisite. It excludes the other pending CLI, plugin, mobile and timeline styling changes. Review found and corrected repeated/opposing hunk undercounts and blank-line loss. The reviewer approved the final correction; the simplification review found no further useful changes.

The exact commit snapshot passed 6,432 app tests across 410 files, all 108 memory tests on Bun 1.3.14, production and test typechecks, ESLint, architecture, agent vocabulary, duplicate and generated-memory checks, and a production web build. The first cold app run timed out in one browser setup test; the next two full runs passed. The installed Bun canary still crashes during memory SQLite teardown, so the full memory run used the pinned stable binary without changing the installed Bun. React Doctor reported no errors and two complexity warnings in the existing timeline components.

Updated usage and tool-rendering documentation reflects the new states and metadata. No push or deployment was performed.
