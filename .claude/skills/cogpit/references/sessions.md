# Cogpit sessions

Use `cogpit-session`; it is on PATH inside Cogpit. Outside Cogpit, use
`~/.cogpit/bin/cogpit-session`. The server must be running. Run
`cogpit-session help` for flags and advanced commands.

Cogpit sets `COGPIT_SESSION_ID` and `COGPIT_PORT`. Keep them: new sessions are
recorded as your children, and commands go to your local server.

To run a child on another computer, also read [devices.md](devices.md). Crew
chat and Slack replies are in [messaging.md](messaging.md).

## Start and collect

```bash
cogpit-session new "Fix the parser and report what changed" --wait --timeout 90
```

For independent tasks, start children without `--wait`, save each returned
`sessionId`, then wait on them together. Use distinct `--worktree NAME` values
when children will edit the same repository.

```bash
A=$(cogpit-session new "Fix the parser" --worktree parser | jq -r .sessionId)
B=$(cogpit-session new "Fix the renderer" --worktree renderer | jq -r .sessionId)
cogpit-session wait "$A" "$B" --timeout 90
cogpit-session children
```

`--cwd DIR` chooses a project. `--agent`, `--instance`, `--model`, `--effort`
and `--name` select how it runs. Long prompts can come from stdin:
`cogpit-session new - --wait < task.md`.

Sessions default to `bypassPermissions` (ACP, which has no such mode, runs
supervised) and to your own effort when they run your agent. Use
`--mode default` when approval is needed, `--effort` to pick another level.
A skill does not grant permission beyond the user's task.

## Delegate further

A child session can start its own children, and those can start theirs. If you
were started by another session and your task splits into independent parts,
start sub-sessions when doing so will finish the work sooner. There is no limit
on how many layers of delegation you can use, as long as each layer keeps the
chain of command intact:

- You own the children you start. Wait for them, answer their requests, and stop
  them when you finish. Do not leave orphaned sessions running.
- Give each child a clear, scoped task and say what it should report back.
- Merge your children's results, review them, and report one combined answer to
  your parent. Your parent should not need to read your children's transcripts.
- Escalate a question to your parent only when neither you nor your children can
  answer it, and pass the answer back down.
- Message your parent when you finish, are blocked, or need a decision it owns.
  Every message wakes it, so progress goes on your board instead (see Status
  board).
- Stay within the scope of your own task. Delegation splits up the work you were
  given; it does not add new work.

## Follow up and inspect

```bash
cogpit-session send "$ID" "Now add a regression test" --command-id parser-tests-001
cogpit-session receipt parser-tests-001 --session "$ID" --wait --timeout 90
cogpit-session wait "$ID" --timeout 90
cogpit-session status "$ID"
cogpit-session result "$ID" --text
```

`send --wait` waits for its delivery receipt; `wait` returns the session's final
reply and changed files. Reuse the same command ID and message after a lost
response. `queued` means accepted, not finished, and `ahead` counts the messages
it waits behind. A plain `send` runs after the current turn ends. Use `--steer`
for anything time-critical; its receipt reads `delivery: steered` once it joined
the running turn. `--interrupt` restarts the turn instead.

`held` and `unknown` messages block everything queued after them; a Cogpit
restart holds every queued message. `status` lists the queue, and
`cogpit-session queue ID` shows what is stuck and how to free it: `--resume`
releases held messages, and `--resolve COMMAND_ID --delivered|--not-delivered`
settles an `unknown` one after you check the child's history with
`cogpit-memory` ([memory.md](memory.md)). Do not resend blindly.

Timeout leaves the child running. Continue with `wait`; do not spawn a duplicate.
Completion is saved and notifies the parent, for the first turn and for each
follow-up you send to your own child. Read it with `cogpit-session tasks`, then
acknowledge it with `tasks --ack TASK_ID`. A `wait` or `new --wait` that already
returned the result acknowledges it for you.

A child blocked on a question or approval notifies you once per request with
"needs attention" and the command that answers it. Only `answer`, `approve` or
`deny` unblock it; a chat post or a `send` does not.

| Exit | Meaning |
| --- | --- |
| 0 | Completed successfully |
| 2 | Needs an answer or approval; inspect `waiting` and `next` |
| 3 | Still running or timed out; keep waiting |
| 1 | Error, missing session or unreachable device; inspect the response |

A turn the agent could not run, such as an API error or a CLI that is not
installed or signed in, settles as outcome `error`. Its `failure.reason` is
`not_installed`, `not_signed_in`, `http_status` (with `httpStatus`) or `other`,
and `error` gives the plain explanation followed by the agent's own words. A
person has to install or sign in to the CLI before a resend can work.

## Status board

Keep your own status current with `board`. The user reads every agent's board
in Cogpit's Status panel without opening its conversation, and the session list
shows a one-line summary under each session that keeps one. Only you can change
your board; anyone may read it with `board get ID`.

```bash
cogpit-session board set - <<'EOF'
title: Release 52
progress: 34/41
sections:
  - title: Needs you
    tone: warning
    items: ["CF token for the router deploy"]
  - title: Now
    items: ["GL-180 nav fix in review"]
  - title: Landed
    tone: success
    items: ["1c019e9 nav wrapper"]
  - title: Next
    items: ["Promotion #51 after CI"]
EOF
cogpit-session board progress 35/41
cogpit-session board get "$CHILD"
```

- Update it when your state changes: a step starts or lands, you get blocked,
  the user answers. Not on a timer.
- Say where things stand now, not the history. What waits on the user goes in a
  `warning` section, what finished in a `success` one.
- Always keep a `Next` section: what is left, in order, or "Nothing left" when
  done. `board set` answers with a `hint` when the board does not say it.
- Up to 6 sections of 12 items, 160 characters each; links stay clickable.
- Read a child's board before messaging it to ask how it is going.

## Orchestrator checklist

- Before you end your turn with children working, make sure each one will
  notify you: you started it with `new` or sent it a follow-up from your own
  session. Otherwise keep a `wait` running. If `new` prints a `warning` about
  `COGPIT_SESSION_ID`, nothing will notify you.
- Shortly after launching, run `children` and check that each child is
  `running`, not `error` or `not_found`.
- Check `status ID` for `waiting` and `queue` whenever a child seems quiet.
- A completion reports the end of a turn. A child whose reply says it is still
  waiting on background agents or commands is not done yet; wait again.
- After a Cogpit restart, children that were mid-turn stopped. Check their
  replies, resume held queues and resend what they still need.
- `stop` cancels messages still queued for the child and stops its own
  children's results from waking it. Stop those children too.

## Answer and clean up

```bash
cogpit-session approve "$ID" --request "$REQUEST"
cogpit-session deny "$ID" --request "$REQUEST" --feedback "Use the smaller change"
cogpit-session answer "$ID" "Blue" --request "$REQUEST"
cogpit-session interrupt "$ID"   # stop the turn, retain the session
cogpit-session stop "$ID"        # stop the session and cancel its queued messages
cogpit-session discard "$ID"     # fetch remote work once more, then remove its worktree
```

Omit `--request` when exactly one matching request is pending. After answering,
wait again. Stop only children you own. `stop` keeps a transferred worktree;
`discard` removes it after preserving its work. For full transcript drill-down,
use `cogpit-memory` ([memory.md](memory.md)).
