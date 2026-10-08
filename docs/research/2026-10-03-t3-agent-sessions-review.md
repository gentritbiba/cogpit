# T3 Code: agent and session architecture comparison

Reviewed 2026-10-03. T3 Code: [pingdotgg/t3code](https://github.com/pingdotgg/t3code), commit `429c625a8515f9c2e4af28c488fbf32ce7789645`. Cogpit core: `5a66d5373f5f4fce1b3db78ce0405f504a25af41`.

T3 has stronger foundations for durable delivery, conversation identity, and client synchronization. Cogpit already uses the appropriate native transports and has a common agent interface. The useful improvements can fit underneath that interface without adopting T3's Effect framework or replacing native transcript access.

This is a source review, not an observed comparison of speed, reliability rates, or UI quality. Recommendations below are engineering judgments from the cited implementations. The optional closed edition package was absent from this checkout; account observations apply to inspected core.

## How T3 wires a conversation

The web, Electron renderer, and mobile clients share connection and state services in `packages/client-runtime`. They send typed RPC commands to the owning environment. A command runs through per-thread serialization, policy decisions, and a database transaction. That transaction writes events, projections, the command receipt, and requested effects. The effect worker then performs provider work. Provider events return through adapters and update durable domain state. Subscribers receive committed, sequenced updates. See [architecture][t3-overview], [EventSink][t3-sink], and [per-thread dispatch][t3-dispatch].

The identities have distinct lifetimes: app conversation, provider instance/account, live provider session, native provider thread, app run, and run attempt. The app conversation survives replacing a process or switching a provider. [Thread contracts][t3-contract] and [session transition policy][t3-transition] make those distinctions explicit.

Codex uses its app-server protocol and Claude uses the Agent SDK, as Cogpit does. Other adapters support ACP and provider-specific protocols. This is an orchestration difference rather than evidence of a better underlying agent. Cogpit's existing [AgentRuntime contract](/Users/gentritbiba/agent-window/server/agents/runtimeTypes.ts:190), [runtime registry](/Users/gentritbiba/agent-window/server/agents/runtimes.ts:44), and [SessionHost contract](/Users/gentritbiba/agent-window/server/sessionHosts/types.ts:12) are suitable integration boundaries.

## Improvements worth borrowing

| Area | T3 implementation | Inspected Cogpit behavior | Recommendation |
| --- | --- | --- | --- |
| Async questions | Persisted requests distinguish message responses from live RPC responses. Required answers are validated; question resolution and answer-message intent commit together. | Codex async questions live in a Map; a new turn removes old questions, and sending any follow-up clears them before delivery succeeds. | Start here: persist each question and its explicit pending/answered/dismissed state. |
| Message delivery | Durable command IDs, receipts, effects, and queued runs. Retries return an existing receipt. Queue entries can be edited, reordered, cancelled, or promoted to steering. | Creation has durable deduplication. Ordinary sends go directly to the runtime; their request has no command ID. Claude has an in-memory SDK input queue. | Add stable message/command IDs and durable acceptance records to UI and CLI sends, then a durable dispatch queue. |
| Conversation identity | App thread and native thread IDs are separate; transition policy chooses reuse, resume, or context handoff. | A session is generally the native agent session ID, resolved through its runtime and transcript location. | Introduce a stable Cogpit conversation ID with explicit native bindings. |
| Reconnect | One connection supervisor per environment; shared subscriptions, sequence cursors, bounded replay or a fresh snapshot. | React hooks use SSE/native transcript byte offsets plus transient token overlays. Reconnect snapshots already rebuild in-flight text. | Share lifecycle/retry ownership and represent data freshness separately; add cursors for durable app events while retaining native file offsets. |
| Agent collaboration | Delegated tasks have durable parent/run linkage, results, wake policy, and completion acknowledgements. Agent sends use stable command/message IDs. | The session CLI already creates, sends, waits, reads results, and routes pending input across hosts. Parent/device origins persist, but this is a session API rather than an equivalent durable delegated-task mailbox. | Preserve the CLI and hosts; add task/result delivery records and explicit acknowledgements behind them. |
| Protocol maintenance | Codex request, response, and notification schemas are generated from a pinned upstream protocol; the client encodes/decodes at the boundary. | Codex protocol interfaces are maintained locally, including broad `JsonObject` parameter types. Existing validation and transport tests cover important paths. | Generate the protocol contract and retain explicit compatibility handling for supported CLI versions. |

### 1. Durable async questions: the smallest direct improvement

T3's [Codex adapter][t3-async] marks async questions as message-response requests. [Recovery][t3-recovery] retains those requests while expiring requests whose live RPC responder died. [Answer handling][t3-answer] validates the question answers and uses a stable answer-message identity in the same command transaction.

Cogpit's [question registry](/Users/gentritbiba/agent-window/server/agents/codexQuestions.ts:58) is transient. [The send path](/Users/gentritbiba/agent-window/server/agents/codexRuntime.ts:808) clears questions before attempting the send. Thus an unrelated follow-up or a failed delivery can remove an actionable question; restarting loses the registry. A durable registry can solve this without an event-sourcing migration. Keep live approvals separate: saving an approval does not restore its lost native response channel.

### 2. Delivery receipts and restart reconciliation

[EventSink][t3-sink] commits command receipt, events, projections, and effects together, then publishes after commit. [Restart recovery][t3-recovery] cancels orphaned process work and preserves unstarted queued runs with `queueHeld: true`, requiring an explicit resume. It does not blindly resend every old effect after restart.

Cogpit already has a careful [creation request store](/Users/gentritbiba/agent-window/server/lib/sessionCreationRequests.ts:27): it fingerprints requests, persists claims, returns known results, and refuses to duplicate an ambiguous creation. Extend that principle to [ordinary sends](/Users/gentritbiba/agent-window/server/routes/session-send.ts:23) and [CLI delivery](/Users/gentritbiba/agent-window/server/sessionHosts/localHost.ts:25). Use one acceptance/completion vocabulary rather than the current route's immediate response for some deliveries and whole-turn wait for others. The client's [send state](/Users/gentritbiba/agent-window/src/hooks/usePtyChat.ts:146) should distinguish accepted, queued, delivered, completed, and failed.

Durable acceptance does not guarantee exactly-once provider execution. T3's [mailbox][t3-mailbox] explicitly describes at-least-once delivery: provider acceptance and the app's receipt cannot commit atomically. Preserve uncertainty and reconcile native identity before retrying.

### 3. Stable conversation IDs and provider handoffs

T3's [contracts][t3-contract] separate app and native identity. Its [transition policy][t3-transition] compares both driver and continuation compatibility. Compatible changes can resume native history; incompatible changes use a portable handoff. Cogpit's [Codex creation](/Users/gentritbiba/agent-window/server/agents/codexRuntime.ts:765) returns the native thread ID as the session ID.

Stable app IDs would let one Cogpit conversation retain its title, task linkage, sidebar position, and app metadata across an agent switch. Keep original transcripts and bind them to the conversation. T3's [handoffs][t3-handoffs] are textual, potentially lossy summaries; they do not preserve native tool state, permissions, or complete context. Adopt explicit continuation policy rather than treating a handoff as a native resume.

### 4. Shared connection ownership and replay

T3's [client connection runtime][t3-connection] scopes connections by environment, handles retries in one supervisor, and separates healthy transport from synchronized data. [Thread replay][t3-stream] limits replay to 128 events and 1 MiB, then uses a bounded snapshot. Its thread state retains applied state and cursor together.

Cogpit already has [snapshot overlays](/Users/gentritbiba/agent-window/server/routes/files-watch.ts:310), [byte-offset catch-up](/Users/gentritbiba/agent-window/server/routes/files-watch.ts:344), [worker burst coalescing](/Users/gentritbiba/agent-window/src/hooks/useLiveSession.ts:150), and [SSE access handling](/Users/gentritbiba/agent-window/src/lib/sessionStream.ts:29). The opportunity is a shared owner and durable app-state cursor, not a mandatory switch from SSE to WebSockets. Native transcript offsets and domain-event sequences serve different purposes.

### 5. Agent-to-agent tasks and completion delivery

T3's [MCP service][t3-mcp] supports delegation, task status/cancellation, creating threads, reading/sending/waiting, and interruption. Agent sends carry a source thread and stable operation IDs. Delegation distinguishes asynchronous parent wakeups from blocking waits; a wait timeout leaves the child running and updates the completion delivery policy.

Cogpit already exposes equivalent basic session operations through [SessionHost](/Users/gentritbiba/agent-window/server/sessionHosts/types.ts:12) and the CLI, with [durable origins](/Users/gentritbiba/agent-window/server/lib/sessionOrigins.ts:75) and multi-host waits. T3's transferable improvement is durable task completion delivery. An MCP front end to Cogpit's existing session services could improve agent discoverability, but MCP alone would not provide durability.

## Conditional additions

- **Concurrent accounts:** T3 creates [instance-owned adapters][t3-registry]. Its [Codex home layout][t3-home] separates auth/model caches while deliberately sharing selected history directories. Cogpit core has one runtime per kind and [Claude account switching](/Users/gentritbiba/agent-window/server/agents/accounts.ts:19). Introduce instance IDs if concurrent accounts are a product requirement. Shared transcripts remain shared data; these profiles are not general filesystem sandboxes.
- **More agents through ACP:** T3's [generic adapter][t3-acp] negotiates capabilities rather than assuming every provider supports native fork, rewind, or model changes. Add a generic ACP implementation underneath Cogpit's existing descriptor/runtime layer if broader provider support is wanted. ACP support does not imply native sandboxing or equivalent rollback semantics.
- **Generated Codex schemas:** the [generator][t3-generator] pins an upstream Codex source ref. Copy the contract-generation approach with a supported-version policy; importing a huge generated schema without compatibility tests would merely move maintenance work.

## Suggested order and verification

1. Persist async questions and resolve only the specific request after accepting its answer.
2. Add message IDs, durable send receipts, explicit delivery states, and restart reconciliation; apply the same path to UI and session CLI.
3. Add stable conversation IDs/native bindings, then a durable delegated-task mailbox.
4. Share connection state/retry ownership and replay durable app events. Generate protocol contracts as a separate maintenance improvement.

Acceptance scenarios should cover a restart with an unanswered question, a failed unrelated send, a response lost after command acceptance, concurrent retries, a queued message during process loss, stale events after a replacement run, and a child completing after the parent's blocking wait ends. Retain Cogpit's required root/public and memory package checks for any implementation.

No application code was changed, agent process launched, or runtime test/benchmark run for this review. Tests in both repositories were inspected as source evidence only. T3's implementation has substantial complexity: its orchestrator is about 10,000 lines at the reviewed commit. Adopt the mechanisms in focused modules within Cogpit's existing boundaries.

T3's [LICENSE][t3-license] is MIT and states that copies or substantial portions must retain its copyright and permission notice. This audit copies no implementation code. Inspect notices for any specific dependency or asset before incorporating it.

Independent review: Codex `/root/t3_independent_review`; architecture review ID `architecture-t3-429c625a-vs-cogpit-5a66d537`; final report review ID `architecture-t3-429c625a-vs-cogpit-5a66d537-report-v1`; both verdicts `APPROVE`, with source-only verification. The final pass checked the report against source and required no material corrections. No patch approval, performance claim, or security certification is implied.

Verified source dependency facts were recorded in [project deployments](/Users/gentritbiba/agent-window/.claude/deployments.md) and [global index](/Users/gentritbiba/project-manager/deployments.md). No hosting, account, provider login, billing, or installed-build state was revalidated.

[t3-overview]: https://github.com/pingdotgg/t3code/blob/429c625a8515f9c2e4af28c488fbf32ce7789645/docs/internals/overview.md
[t3-sink]: https://github.com/pingdotgg/t3code/blob/429c625a8515f9c2e4af28c488fbf32ce7789645/apps/server/src/orchestration-v2/EventSink.ts#L518
[t3-dispatch]: https://github.com/pingdotgg/t3code/blob/429c625a8515f9c2e4af28c488fbf32ce7789645/apps/server/src/orchestration-v2/Orchestrator.ts#L9629
[t3-contract]: https://github.com/pingdotgg/t3code/blob/429c625a8515f9c2e4af28c488fbf32ce7789645/packages/contracts/src/orchestrationV2.ts#L357
[t3-transition]: https://github.com/pingdotgg/t3code/blob/429c625a8515f9c2e4af28c488fbf32ce7789645/apps/server/src/orchestration-v2/ProviderSessionTransitionPolicy.ts#L48
[t3-async]: https://github.com/pingdotgg/t3code/blob/429c625a8515f9c2e4af28c488fbf32ce7789645/apps/server/src/orchestration-v2/Adapters/CodexAdapterV2.ts#L4384
[t3-answer]: https://github.com/pingdotgg/t3code/blob/429c625a8515f9c2e4af28c488fbf32ce7789645/apps/server/src/orchestration-v2/Orchestrator.ts#L6906
[t3-recovery]: https://github.com/pingdotgg/t3code/blob/429c625a8515f9c2e4af28c488fbf32ce7789645/apps/server/src/orchestration-v2/ProviderRuntimeRecoveryService.ts#L214
[t3-mailbox]: https://github.com/pingdotgg/t3code/blob/429c625a8515f9c2e4af28c488fbf32ce7789645/apps/server/src/orchestration-v2/NotificationMailbox.ts
[t3-handoffs]: https://github.com/pingdotgg/t3code/blob/429c625a8515f9c2e4af28c488fbf32ce7789645/docs/internals/context-handoffs.md
[t3-connection]: https://github.com/pingdotgg/t3code/blob/429c625a8515f9c2e4af28c488fbf32ce7789645/docs/internals/connection-runtime.md
[t3-stream]: https://github.com/pingdotgg/t3code/blob/429c625a8515f9c2e4af28c488fbf32ce7789645/apps/server/src/orchestration-v2/ThreadStream.ts
[t3-mcp]: https://github.com/pingdotgg/t3code/blob/429c625a8515f9c2e4af28c488fbf32ce7789645/apps/server/src/mcp/OrchestratorMcpService.ts#L1356
[t3-registry]: https://github.com/pingdotgg/t3code/blob/429c625a8515f9c2e4af28c488fbf32ce7789645/apps/server/src/orchestration-v2/ProviderAdapterRegistry.ts#L263
[t3-home]: https://github.com/pingdotgg/t3code/blob/429c625a8515f9c2e4af28c488fbf32ce7789645/apps/server/src/provider/Drivers/CodexHomeLayout.ts#L19
[t3-acp]: https://github.com/pingdotgg/t3code/blob/429c625a8515f9c2e4af28c488fbf32ce7789645/apps/server/src/orchestration-v2/Adapters/AcpAdapterV2.ts#L614
[t3-generator]: https://github.com/pingdotgg/t3code/blob/429c625a8515f9c2e4af28c488fbf32ce7789645/packages/effect-codex-app-server/scripts/generate.ts#L20
[t3-license]: https://github.com/pingdotgg/t3code/blob/429c625a8515f9c2e4af28c488fbf32ce7789645/LICENSE
