# Tool-call redesign documentation audit

Date: 2026-09-13
Commit: dc4fbda
Release: 2.6.6
Verdict: PASS after scope clarifications.

The release redesigns the shared web timeline used by desktop browsers, Electron, and mobile browsers. Calls have readable action names, individual disclosures, explicit running/failure/missing-result status, and bounded output previews. Adjacent shell calls remain separate. Automatically opened live groups retain the latest three entries and all pending or failed calls. Native iOS code is unchanged.

Reviewed `docs/tool-call-rendering.md` against `ToolCallCard`, `ToolCallStatus`, `CollapsibleToolCalls`, `BashCommandCard`, `ToolCallResult`, `ToolCallInput`, and `toolActivity`, including their regression tests. Checked the existing native presentation model, `ios/UI_SPEC.md`, and `ios/PARITY_STATUS.md` for the operation meanings and native disclosure scope. `docs/ui-simplification.md` already identifies itself as the original design plan and points to the current contract.

Clarified the contract heading as shared web structure, limited the three-entry description to automatically opened live groups, described section disclosures as applying to sections with output, and made native verification conditional on native presentation changes. These changes avoid implying that this release changes native controls or requires empty-output sections to expand.

The removed `activitySummary` and `workLogTail` modules have no remaining production consumers or active documentation references. Their tests and obsolete agent-vocabulary entry were removed. The `TurnSection` prop deduplication and `useSessionState` reducer consolidation preserve existing behavior and need no user documentation. The package version is 2.6.6. Unrelated local CLI, permission, and dependency work is outside this audit and release scope.

Validation evidence reviewed: the cleanup passed `check:agents`, and the targeted `toolActivity` and `ToolCallCard` suites passed 138 tests. The release owner runs final checks against the isolated release snapshot. This audit does not claim new browser or native runtime testing.

Final isolated release validation: 6,373 application/server tests across 408 files pass with coverage, 108 memory tests pass on CI Bun 1.3.14, and all 9 launcher tests pass. Production/test typechecks, lint, dependency audit, architecture, agent vocabulary, shared-module sync, web/Electron builds, and memory/launcher package contracts pass. Duplicate gate passes unchanged at 62/63 clones and 544/555 duplicated lines. The staged release tree matched the validated isolated snapshot byte-for-byte.
