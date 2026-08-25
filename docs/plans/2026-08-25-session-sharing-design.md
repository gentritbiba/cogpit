# Session sharing

**Status:** design, not yet implemented
**Date:** 2026-08-25

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
sessions have today.

## Auth flow

1. Host enables sharing. Server mints the record, returns `{ url, passphrase }`.
2. Guest opens `https://<host>/shared/<sessionId>`. `isPublicPath` already
   returns true for non-`/api` paths, so the SPA shell loads unauthenticated.
   No server change is needed to serve the HTML.
3. The SPA renders a login screen and POSTs `/api/share/verify` with
   `{ sessionId, password }` — one new entry in `PUBLIC_PATHS`.
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

## Scoping

Default deny. A share request reaching a route not on the allowlist gets 403.

### URL-keyed reads

These name their target in the path, so the share branch verifies them against
the record directly. Keeping the real paths means `useLiveSession` and
`loadSessionTailCached` work in the shared shell unchanged.

| Route | Check |
|---|---|
| `GET /api/sessions/:dirName/:fileName` | pair matches the share |
| `GET /api/watch/:dirName/:fileName` | pair matches |
| `GET /api/session-status/:sessionId` | id matches |
| `GET /api/session-file-changes/:sessionId` | id matches |
| `GET/PUT /api/session-config/:key` | key is `<sessionId>.jsonl` |

### Body-keyed mutations

`authMiddleware` runs before body parsing, so it cannot inspect
`body.sessionId` on `send-message` or `stop-session`. Checking inside each
handler would be a decentralized guard that someone eventually forgets.

So guests do not get those routes. They get a namespace where the guest never
names a session — the sessionId comes from the share token, leaving nothing to
spoof:

```
POST /api/share/send-message   { text, images? }
POST /api/share/stop
POST /api/share/interrupt
POST /api/share/permission     { requestId, decision }
POST /api/share/answer         { questionId, answer }
GET  /api/share/session        -> { dirName, fileName, title, provider }
```

Each is a thin delegation to the existing handler with the sessionId injected.

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

`SharedRoot` calls `GET /api/share/session`. 401 renders `SharedLoginScreen`
(passphrase field, rate-limit message on 429). Success renders the transcript
and a chat input, composed from the existing renderer and input.

**Known risk:** `ChatArea` and the input read from `SessionInventoryContext`
and `PendingHumanInputContext`, which poll `/api/active-sessions` and
`/api/running-processes` — both denied. They need thin share-scoped providers
backed by `/api/share/session` and `/api/session-status`. This is the part
most likely to exceed its estimate.

### Share button

A `Share2` button in `FloatingChrome`: ghost when off, accent-filled when on,
so an active share is never invisible. Clicking opens a popover.

Off state: one line of explanation, one Enable button.

On state: the link with copy, the passphrase (full text immediately after
minting, `••••` plus Regenerate afterward), a combined **Copy link &
passphrase**, a live guest count, and Stop sharing.

When `networkAccess` is off, an inline note that the link is reachable on this
machine only.

### Host API

Normal auth, `admin` in `ROUTE_POLICIES`:

```
POST   /api/shares                       -> { url, passphrase }
DELETE /api/shares/:sessionId
POST   /api/shares/:sessionId/regenerate -> { passphrase }
GET    /api/shares                       -> [{ sessionId, title, createdAt, guests }]
```

The list feeds a "Shared sessions" section in Network settings, so no share
stays open and forgotten.

## Lifecycle

- Turning off network access revokes live guest tokens, keeps the records.
- Changing the network password calls `revokeAllSessions()`. Shares must be
  excluded — they are a separate credential.
- Deleting a session deletes its share.
- Branching or duplicating a session does not carry a share over.
- No auto-expiry on records in v1. The settings list is the mitigation.

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
  that sharing was turned off. Needs a share-token equivalent of
  `trackAuthenticatedHttpStream`.
- Session file deleted underneath a guest: terminal state, not a retry loop.

## Tests

The load-bearing one is allowlist completeness: iterate `API_ROUTE_REGISTRY`,
hit every route with a share token, assert 403 unless allowlisted. This mirrors
how `api-routes.test.ts` pins canonical route ids, so a route added later is
denied by default and the test proves it.

Also:

- mint, verify, regenerate, revoke
- wrong password and unknown share are indistinguishable
- cross-session rejection: share for A, request B's `dirName/fileName`
- team-edition parity
- guest token revoked on network-access-off, survives network-password change
- component tests for the share button and `SharedRoot`

## Non-goals

- Attribution. Guest messages are indistinguishable from the host's in the
  JSONL; adding an author field would pollute the transcript format.
- Presence beyond a connection count.
- Sharing through the hub.
- Read-only shares.
