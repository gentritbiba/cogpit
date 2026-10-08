# Durable agent conversations

Cogpit owns a stable conversation identity. A native binding records the machine,
provider, account instance and native session. Messages keep the binding revision
they were accepted against; a handoff holds older queued messages for review.

## Sending and recovery

The composer, session CLI and session MCP tools share one command dispatcher.
Acceptance returns a receipt immediately. Queued messages can be edited, reordered,
cancelled, promoted to steering where supported, or used to restart a turn.
After a handoff, old session addresses can read the queue and its current address;
queue mutations require opening the current session.
Editing or changing an intent creates a new immutable command ID. Retrying the
same ID and content returns the original receipt; changing its content is refused.

A database lease and attempt epoch fence competing hosts. Permissions are checked
again before native delivery. On restart, unsent work is held and in-flight work
becomes `unknown`. Inspect native history before confirming completion, failure,
or an explicit resend. Unknown deliveries are never replayed automatically.
Definitive model rejection before a Codex turn is accepted can trigger one default
model retry while the conversation is open; timeouts and partial turns cannot.

Async questions survive turn completion and app restart. Each answer has its own
receipt. An answer rejected before native delivery reopens its question. A later
turn failure keeps an accepted answer resolved. Cancelling or editing a queued
answer keeps the corresponding question and command linked.

## Continuing a conversation

Open the session’s overflow menu and choose **Continue with another provider…**.
The option is available only for existing conversations you can drive.

Native resume requires a compatible provider and account instance. Cross-provider
continuation creates a new native session with the last twelve text turns, capped
at 24,000 characters. Attachments and tool payloads are excluded from that briefing.
The source history remains accessible. An uncertain creation holds the transition
until its reported native session is attached, or the user confirms no session was
created after checking native history. Retrying a resolved transition returns the
same native session.

## Delegation and tools

`cogpit-session new --wait` returns and acknowledges a completed child result.
A timeout leaves the child running. Eventual completion is persisted and queues
one parent notification under a stable command ID. An abandoned blocking wait
expires, restoring asynchronous notification. Results can be acknowledged or tasks
cancelled in the conversation controls or with `cogpit-session tasks`.

`POST /api/session-mcp` provides stateless JSON-RPC tools using MCP version
`2025-03-26`. Tools reuse the session CLI and its authorization. Mutating calls
require a stable `commandId`. Hosts supporting these operations advertise
`sessionApi: 2`; older devices must be upgraded before durable writes or handoffs.

## Provider accounts and ACP

The provider account dialog creates a separate home, settings, history and worker
process. Existing credentials are not copied. It shows the environment and command
for signing in through the provider's own CLI. Removing an instance retires it;
history and login files stay available. Busy instances cannot be retired.
Workers publish current activity and pending requests before reporting a turn's
completion, so completed turns cannot leave the parent displaying stale busy state.

ACP instances accept an executable and argument array and speak the official
stable v1 protocol through `@agentclientprotocol/sdk` 1.7.0. The adapter negotiates
initialization, create/load, prompts, cancellation, permissions and offered model
configuration. Unsupported controls fail explicitly. Native fork, rewind,
filesystem/terminal client requests and MCP configuration are not advertised.
Reloaded history is not appended a second time. Worker events are forwarded under
account-qualified session IDs. Ownership and lineage preserve those namespaces;
team configurations are read from the owning account's home.

Agent environments include `COGPIT_ORCHESTRATION_ROOT`. `cogpit-memory` uses that
root to discover account profile metadata and keeps account-qualified IDs in
search and context results. Inside a provider worker it sees that profile's store.
An independently launched memory CLI can set that variable to Cogpit's data root.

## Storage and packaging

SQLite at `<dataRoot>/orchestration/state.sqlite` is separate from native provider
transcripts. Node uses its native SQLite driver; Bun uses `bun:sqlite`. It uses WAL and FULL synchronous transactions, owner-only files on
POSIX, transactional schema version 3 migrations, and refuses future schemas.
Answer links and handoff reservations retain the caller scope. Legacy answer links
remain resolved until explicit reconciliation; legacy handoffs acquire an owner
only when exactly one stored operation identifies it. Ambiguous legacy records
remain blocked for inspection. Commands admit at most 100 pending items per conversation, 50 MB per payload,
and 512 MB of retained command payloads globally. Replay keeps 10,000 events.

Terminal command bodies, resolved answers, old replay events and acknowledged
results are pruned after thirty days on startup and daily. Command and operation
fingerprints remain as deduplication tombstones. Unresolved questions, unknown
deliveries and uncertain creations remain available for recovery. Those retained
records and native history are not subject to the terminal-payload cap.

The npm launcher requires Node 22.16 or newer and checks it before importing the
server. Both npm and Electron package the provider worker beside the host entry.
Codex types and request schemas are generated from CLI 0.160.0; use
`bun run generate:codex-protocol` to refresh the pin deliberately and
`bun run check:codex-protocol` to detect schema/provenance drift.

## Seeing and steering a crew

Mission Control is the home: one oldest-first request queue, the sessions you
started with their crews, and today’s PRs, starts and finished members. All
projects opens the existing project history; choosing a project starts the
normal new-session composer. Mobile Workspace opens the same queue.

Spawned sessions fold under their coordinator in the sidebar, including across
worktree folders. Search stays flat and shows lineage. The Crew panel opens
on the first visit to a crew, remains rooted at its coordinator while opening
members, and offers request answers, member navigation, stop and result
acknowledgment. Requests show their actual waiting time when the provider
records it.

Final assistant replies can render `cogpit-status`, `cogpit-decisions` and
`cogpit-checklist` fences. Quoted blocks in user prompts remain code. Decision
answers persist per reply and block, and send together as one message.
`cogpit-session board set`, `progress`, `get` and `clear` keep a local session
board pinned above the crew’s composer.

The global device list, wall view, delegation budgets/launch review and editable
boards are later phases. Current home data is scoped to the selected device.
