# Session sharing

**Status:** implemented
**Date:** 2026-08-25 (design), 2026-08-26 (reconciled with the shipped code)

Where implementation diverged from the original design, this document describes
what was built. The plan beside it (`2026-08-25-session-sharing-plan.md`) is the
historical task list and was not rewritten.

Let a second person join one Cogpit session over the existing network/tunnel
access, without giving them the rest of the app.

## What a guest gets

Full participation in exactly one session: read the live transcript, send
messages, answer AskUser prompts, approve or deny tool permission requests,
stop and interrupt turns.

That last capability means a share credential can cause arbitrary commands to
run on the host. The design treats it as equal in sensitivity to the network
password, differing only in scope.

Explicitly out of scope for a guest: project list, other sessions, config,
the file browser, terminal, editor and Finder handoffs, worktrees.

## Credential model

One password per shared session, auto-generated.

Toggling share on mints a four-word passphrase (`copper-lantern-drift-92`),
~60 bits, over the 16-character minimum `validatePasswordStrength` enforces,
and speakable over a call. Plaintext is returned once at mint time and never
again; Regenerate rotates it and kicks live guests.

Sharing requires network access to be on. In personal edition a share *is*
remote access, so minting one while that switch is off would quietly reopen the
door it closed: `POST /api/shares` answers 409 and the share branch of the
middleware refuses guests for as long as it stays off. Team edition has no such
switch — user credentials replace it — so the check does not apply there.

Rejected alternatives:

- **One global share password.** Fewer secrets to ship, but a guest who
  collects two links reaches both sessions.
- **Link-only capability URL.** Zero friction, but the link alone is host
  code execution, and links land in Slack threads and screenshares.
- **Reuse the network password.** Simplest, but the guest could then log in
  at `/` and see everything.

The share password is deliberately independent of the network password. A
guest gets one session, not your Cogpit.

## Storage

`<DATA_ROOT>/shares.local.json`, mode 0600, written with the existing
`writeOwnerOnlyJson`, following the `devices.local.json` pattern:

```
{ sessionId, dirName, fileName, passwordHash, createdAt, lastAccessAt }
```

Hashed with `password-utils` (`$scrypt$`, N=16384, r=8, p=5).

Records live in a file so they survive restart. Guest tokens are in-memory
only, so a restart logs guests out — the same behavior personal-edition
sessions have today. A token is pinned to the User-Agent it was minted for,
expires on the same idle and absolute TTLs as a browser session, and a session
holds at most `MAX_SHARE_GUESTS_PER_SESSION` (8) live tokens: a ninth mint
evicts the oldest rather than letting a link accumulate an unbounded audience.

## Auth flow

1. Host enables sharing. Server mints the record, returns `{ url, passphrase }`.
2. Guest opens `https://<host>/shared/<sessionId>`. `isPublicPath` already
   returns true for non-`/api` paths, so the SPA shell loads unauthenticated.
   No server change is needed to serve the HTML.
3. The SPA renders a login screen and POSTs `/api/share/verify` with
   `{ sessionId, passphrase }` — one new entry in `PUBLIC_PATHS`.
4. Server rate-limits with the existing `isRateLimited`, verifies against that
   share's hash, mints a share token into a store separate from
   `activeSessions` (keeping team edition's `SessionPrincipal` uncontaminated),
   and sets `__Host-cogpit_share` with the same attributes as
   `setBrowserSessionCookie`: HttpOnly, Secure, SameSite=Strict, Path=/.

### Middleware precedence

In `authMiddleware`, a valid main bearer or cookie wins. Otherwise, if a share
cookie is present, the request enters the share branch and never falls through
to full access — including past `isTrustedDirectLocalRequest`, which would
otherwise hand a guest arriving on loopback the entire app.

`teamAuthMiddleware` gets the same branch. It trusts nothing, loopback
included, so behavior is identical across editions.

Two things the branch does that the original sketch did not:

- It re-checks network access before anything else, because it sits *above* the
  gate both middlewares apply to ordinary remote requests. Without that a guest
  would be admitted on a request a normal remote user gets 403 on.
- It marks the request as a share guest before calling `next()`. Team edition's
  authz middleware refuses anything it cannot account for, and a guest carries
  no `SessionPrincipal` by design, so it has to arrive there labelled rather
  than as nothing at all.

## Scoping

Default deny. A share request reaching a route not on the allowlist gets 403.

### URL-keyed reads

These name their target in the path, so the share branch verifies them against
the record directly. Keeping the real paths means `useLiveSession` and
`loadSessionTailCached` work in the shared shell unchanged.

`/api/session-file-changes` is `admin` in team edition, so a guest reaches a
route a non-admin member does not. That inversion is intended: a member is
bounded by team governance, whereas a guest was invited into one specific
session by an admin and is already reading that session's tool calls, absolute
paths and all.

`session-config` ended up GET-only. The route shallow-merges whatever JSON it is
handed, and that file carries the session's permission mode and MCP selection —
a guest who could `PUT` it could switch the session to bypassPermissions.

The identity check is two segments exactly, which is also what denies
`/api/sessions/:dir/:id/subagents/agent-N.jsonl`. Sub-agent transcripts are
therefore unreachable for a guest; `AgentPanel` says so rather than expanding to
an empty panel.

| Route | Check |
|---|---|
| `GET /api/sessions/:dirName/:fileName` | pair matches the share |
| `GET /api/watch/:dirName/:fileName` | pair matches |
| `GET /api/session-status/:sessionId` | id matches |
| `GET /api/session-file-changes/:sessionId` | id matches |
| `GET /api/session-config/:key` | key is `<sessionId>.jsonl` |

### Body-keyed mutations

`authMiddleware` runs before body parsing, so it cannot inspect
`body.sessionId` on `send-message` or `stop-session`. Checking inside each
handler would be a decentralized guard that someone eventually forgets.

So guests do not get those routes. They get a namespace where the guest never
names a session — the sessionId comes from the share token, leaving nothing to
spoof:

```
POST /api/share/send-message   { message, images? }
POST /api/share/stop
POST /api/share/interrupt
POST /api/share/permission     { requestId, behavior }
POST /api/share/answer         { toolUseId, answers }
GET  /api/share/session        -> { sessionId, dirName, fileName, title, provider }
GET  /api/share/pending        -> { permissions, questions }
```

Each is a thin delegation to the existing handler with the sessionId injected.

`GET /api/share/pending` was added during implementation. A guest may *answer* a
permission request but had no way to *see* one: `/api/permissions` and
`/api/user-questions` are both off the allowlist, `/api/session-status` carries
no permission data, and the `/api/watch` stream carries only transcript lines.
Both reads are folded into one endpoint because the guest polls them on the same
tick, and one round trip over a tunnel beats two.

### Denied

`/api/projects`, `/api/active-sessions`, `/api/config`,
`/api/config-browser/*`, `/api/file-content`, `/api/project-file`,
`/api/open-in-editor`, `/api/reveal-in-folder`, `/api/open-terminal`,
`/api/worktrees`, `/__pty`, and everything else. A guest sees the transcript
and the diffs inside it, not a file browser or a shell.

## Frontend

### Routing

`src/main.tsx` branches before anything else:

```
isSharedPath(location.pathname) ? <SharedRoot/> : <DeviceRoot/>
```

Branching at the root rather than inside `App.tsx` keeps the shared view clear
of the login gate, the `SetupScreen` config gate, device switching, hub
prefixes, the sidebar, and the command palette. No path exists where a guest
renders a component that assumes full access.

`SharedRoot` (`src/components/SharedSession/`) calls `GET /api/share/session`.
401 renders `SharedLoginScreen` (passphrase field, rate-limit message on 429,
tunnel hint on 426). Success renders the transcript and a chat input, composed
from the existing renderer and input.

**The known risk, as resolved.** The transcript and composer turned out to read
`AppContext`, `SessionContext` and `SessionChatContext` and nothing else — not
`SessionInventoryContext` or `PendingHumanInputContext`, which the design named.
`src/contexts/ShareScopedProviders.tsx` supplies those three from what a guest
may fetch and nothing more, so no allowlist entry was added to satisfy a
component. Two details there are load-bearing rather than cosmetic: it calls
`setMe(GUEST_ME)` so the module-level capability cell reports a guest (host
affordances like the @-mention file picker read that cell directly, not the
context), and it passes `false` to `useUndoRedo` so rewinding is disabled rather
than stubbed.

### Share button

A `Share2` button in `FloatingChrome`: ghost when off, accent-filled when on,
so an active share is never invisible. Clicking opens a popover.

Off state: one line of explanation, one Enable button.

On state: the link with copy, the passphrase (full text immediately after
minting, `••••` plus Regenerate afterward), a combined **Copy link &
passphrase**, a live guest count, and Stop sharing.

When `networkAccess` is off, an inline note that the link is reachable on this
machine only.

The button renders only when the current principal holds the `share`
capability, which in team edition is admin-only: handing out a share is handing
out host code execution, so it is not a member-level action.

### Host API

Normal auth, `admin` in `ROUTE_POLICIES`:

```
POST   /api/shares                       -> { url, passphrase, share }
DELETE /api/shares/:sessionId
POST   /api/shares/:sessionId/regenerate -> { passphrase }
GET    /api/shares -> [{ sessionId, dirName, fileName, title,
                         createdAt, lastAccessAt, guests }]
```

`url` is the relative `/shared/<sessionId>`; only the browser knows the origin
to put in front of it.

`POST /api/shares` takes only a `sessionId` and resolves `dirName`/`fileName`
itself via `findJsonlPath`, then requires that pair to round-trip back to the
same file — a client that could name the file could point a share at any JSONL
on disk. It refuses two cases outright: 409 when network access is off, and 400
for a Codex session, whose rollout lives at a nested path
(`2026/08/25/rollout-<ts>-<uuid>.jsonl`) that the two-segment allowlist rule
would 403 on every read. Minting a passphrase for a share that cannot be opened
is worse than refusing it, and widening the segment rule is its own change with
its own review — that function shipped a traversal bug once already.

The list feeds a "Shared sessions" section in Network settings, so no share
stays open and forgotten.

## Lifecycle

- Turning off network access revokes live guest tokens, keeps the records.
- Changing the network password calls `revokeAllSessions()`. Shares must be
  excluded — they are a separate credential.
- Deleting a session deletes its share.
- Branching or duplicating a session does not carry a share over.
- Changing the projects root clears every share and its guests. A record
  addresses a `dirName`/`fileName` inside one root; under a different root that
  pair is a different session, or none.
- No auto-expiry on records in v1. The settings list is the mitigation. Guest
  *tokens* do expire, on the standard browser-session TTLs.

## Hub

Out of scope. `/shared/*` is not under `/api/`, and the hub proxy already 404s
non-`/api/` paths, so it is blocked by construction. Guests connect to the
device directly.

## Failure modes

- Wrong passphrase and nonexistent share return an identical 401, so shares
  are not enumerable. Rate-limited by `isRateLimited`.
- `canIssueBrowserSession` requires HTTPS. Over the tunnel that holds; over
  plain LAN http, share login returns 426 pointing at the tunnel, matching
  existing browser-login behavior.
- Share revoked mid-session: the guest's SSE is destroyed and the shell states
  that sharing was turned off. `trackShareHttpStream` is the share-token
  equivalent of `trackAuthenticatedHttpStream`, and its recheck consults the
  registry as well as the token map, so a stream closes on "Stop sharing" even
  if nothing remembered to revoke the token.
- Share revoked or rotated *during* the login's scrypt derivation (~95ms).
  `handleLogin` captures the hash before deriving and re-reads it after, and
  refuses with the same generic 401 if it changed — otherwise a dead passphrase
  authenticates against a record that no longer exists.
- Session file deleted underneath a guest: terminal state, not a retry loop.

## Tests

The load-bearing one is allowlist completeness: iterate `API_ROUTE_REGISTRY`,
hit every route with a share token, assert 403 unless allowlisted. This mirrors
how `api-routes.test.ts` pins canonical route ids, so a route added later is
denied by default and the test proves it.

Also:

- mint, verify, regenerate, revoke
- wrong passphrase and unknown share are indistinguishable
- cross-session rejection: share for A, request B's `dirName/fileName`
- team-edition parity
- guest token revoked on network-access-off, survives network-password change
- component tests for the share button, `SharedRoot`, `SharedLoginScreen` and
  `SharedSessionView`

They live in `server/__tests__/share/`, `server/__tests__/routes/shares.test.ts`
and `share-guest.test.ts`, and `src/components/SharedSession/__tests__/`.

## Non-goals

- Attribution. Guest messages are indistinguishable from the host's in the
  JSONL; adding an author field would pollute the transcript format.
- Presence beyond a connection count.
- Sharing through the hub.
- Read-only shares.
- Sharing a Codex session.
- Sub-agent transcripts. The guest allowlist admits exactly two identity
  segments and a sub-agent file needs four, so `AgentPanel` tells the guest the
  transcripts are unavailable instead of expanding to nothing.
