# Slack Links

Link a session to a Slack app, and the people you allow can talk to it from
Slack: direct messages, Assistant threads, thread replies and @mentions arrive
in the session as steering messages, and the session answers in the thread
they came from.

## Setup

The Slack app needs Socket Mode on, an app-level token with
`connections:write`, and these bot scopes: `app_mentions:read`,
`assistant:write`, `chat:write`, `im:history`, `im:read`, `im:write`, plus
`channels:history`/`groups:history` if it is to follow threads in channels.
Subscribe it to the `message.im`, `app_mention`, `assistant_thread_started`
and (for channels) `message.channels`/`message.groups` bot events.

```bash
# Tokens are read from a file on the machine that runs the session, never from argv.
cogpit-session slack bot add odyssey --env-file ~/odyssey-agent/.env   # SLACK_BOT_TOKEN, SLACK_APP_TOKEN
cogpit-session slack link <sessionId> --bot odyssey                    # allowlist defaults to the owner
cogpit-session slack status <sessionId>
cogpit-session slack unlink <sessionId>
```

`link` options: `--allow U1,U2` (who may write to the session), `--dm D1` (a
DM the bot cannot open itself), `--channel C1,C2` (channels it may also post
in), `--auto-post on|off` (default off) and `--daily-cap N` (default 20).
Linking again changes only the options given.

**Settings → Slack links** lists each link with its session, bot, connection
state, who it listens to, where it may post and today's posts, plus messages
still waiting or left uncertain by a restart. From there you can switch
auto-post or unlink a session. Adding bots and linking stay in the CLI, so
tokens are read from files on the host and never pass through the browser.
`GET`/`POST /api/slack` serve it, for host administrators only.

Inside the linked session:

```bash
cogpit-session slack reply --thread 1793194235.652149 "Done: **3 PRs** merged"
cogpit-session slack reply "Top-level message in the DM"
```

Markdown is converted to Slack mrkdwn and long replies are split.

## How it works

`server/slack/` runs inside the Cogpit server that hosts the session, from
both the desktop app and `cogpit-server`. It opens one Socket Mode connection
per linked bot (`apps.connections.open`, then a WebSocket), so it needs no
public URL. It reconnects when Slack asks (`disconnect`), when the socket
closes, and when it has been silent for 90 s or has not said `hello` within
that time.

Inbound, for each event:

1. `routing.ts` decides. It ignores the bot's own messages, other bots, edits,
   deletions, joins and people not on the allowlist, and records the reason so
   that `status` can show it. In a channel it follows only mentions and
   replies in threads it already knows.
2. The message goes to the inbox in `~/.cogpit/slack/state.json`, written
   durably. Only then is the envelope acknowledged. If the write fails, Slack
   sends the event again.
3. The inbox hands the message to the session's durable command queue (the
   same path as `cogpit-session send --steer`) with a command id derived from
   the message. It joins a running turn, or starts one when the session is
   idle. A provider that cannot steer queues the message instead. If delivery
   fails (session restarting, server stopping), the message stays in the
   inbox and is retried with backoff, in order.
4. After a restart, every message whose turn had not ended is checked
   against its receipt. Cogpit holds queued work when it restarts. A held
   Slack message is released on its own, under a new command id, while the
   rest of the session's queue stays held. One that was mid-delivery when
   Cogpit stopped is listed as `uncertain` in `status` rather than sent
   twice.
5. In a DM or Assistant thread, the thread status shows "is thinking…" until
   the turn ends. With auto-post on, the answer is then posted into the
   thread, unless the session already answered there itself. The answer is
   the last text the turn wrote after this message and before any later
   message was steered in, so it never includes work done for someone else.

A message keeps its thread: a top-level message's own `ts` becomes its thread,
so a reply lands under it. Duplicates collapse on `team:channel:ts`, which
covers Slack's resends and the `message` + `app_mention` pair a mention
produces.

Outbound posts go through `outbound.ts`, which checks each one against the
policy below. A 429 waits for `Retry-After` and retries up to three times.

## Threat model

The risks this feature has to contain are that someone other than the
allowlisted people drives the session, and that the session posts where it
should not.

| Risk | Control |
|---|---|
| A stranger, a bot, or the bot itself writes to the session | Only `allow` users are delivered; `bot_id`, `bot_message` and the bot's user id are dropped. The allowlist defaults to the owner. |
| An edit rewrites an instruction after the fact | Edits and deletions are ignored, not re-delivered. |
| Forwarded or quoted text carries instructions | The person's own words come first. Forwarded messages are added with every line prefixed `> `, so their content cannot end the quote early, and the session is told that `>` lines are data, not instructions. Slack quotes in the person's own text already start with `>`. |
| The session posts in a channel | Posts go only to the DMs of allowlisted people with the bot, plus channels listed with `--channel`. A mention in any other channel is delivered with a note to answer in the DM. |
| A runaway loop spams Slack | 20 posts per UTC day per link by default (each chunk of a long reply counts), and the same text to the same place within 30 minutes is dropped. |
| Tokens leak | Tokens are kept in `~/.cogpit/slack/bots.json` (0600, in a 0700 directory) and read from files, so they never appear in argv or a transcript. Every API call puts them in the `Authorization` header. `status` and `bots` never return them. |
| Two servers hold the same app token | Slack spreads events across all open connections, so a second consumer would take some of them. A bot links to one session on one machine. Only the server that publishes `~/.cogpit/port` (or one given `COGPIT_SLACK_DIR`) starts links, so QA servers stay off. |
| Someone with Cogpit access links a session | `bot add`, `link`, `unlink` of another session and `reply --session` need an admin. A session may unlink itself and reply as its own link. Cogpit editions with accounts refuse links for now, because delivery runs without a signed-in request. |

Linked sessions still follow their own instructions. Global rules such as
"never send Slack messages" apply, so tell the session that replies through
its link are allowed.

## Files

`server/slack/`: `routing.ts` (event → decision), `service.ts` (links, inbox,
posting, the watcher that ends a turn), `socket.ts` (Socket Mode),
`outbound.ts` (post policy), `mrkdwn.ts`, `prompt.ts` (what the session
reads), `store.ts`, `api.ts`, and `index.ts`, which wires it to the local
session host. The CLI is in `server/sessionCli/slack.ts`, the settings route in
`server/routes/slack.ts`, the UI in `src/components/ConfigDialog/SlackSection.tsx`,
and the shared report type in `shared/contracts/slack.ts`. Tests are in
`server/__tests__/slack/`.
