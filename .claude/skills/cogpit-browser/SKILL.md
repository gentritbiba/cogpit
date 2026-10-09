---
name: cogpit-browser
description: Use agent-browser inside Cogpit with shared live browsers, persistent logins, user handoffs and private subagent browsers.
---

# Browser work inside Cogpit

Use the normal `agent-browser` commands. Cogpit manages profiles and streams
shared browsers in the Browser panel. Name the browser when starting or
switching: "Working in the `default` browser — open the Browser panel to watch."

## Main session

```bash
agent-browser open https://example.com
agent-browser snapshot -i
agent-browser click @e1
agent-browser screenshot /tmp/page.png
```

No `--session` means `default`. Its profile and logins persist across restarts.
Leave `default` running unless the user asks to close it or it must relaunch
for a bot check. Use `--session NAME` for a separate persistent browser;
names match `^[a-z0-9][a-z0-9_-]{0,39}$`.

## Delegated agents

If you are a subagent, use `--session tmp-<unique>` on every browser command:

```bash
agent-browser --session tmp-parser-check open https://example.com
agent-browser --session tmp-parser-check snapshot -i
agent-browser --session tmp-parser-check close
```

Never touch `default` or a named browser from a subagent. They share the user's
page state. Close your private browser when finished. Recognized SDK subagent
calls are redirected, but scripts and other tools may be outside hook coverage;
keep explicit private names and report the browser actually used.

## Login and bot checks

For login or 2FA, ask the user to log in inside the Browser panel, naming the
browser and tab. Pause browser actions, wait for confirmation, select that tab,
and take a fresh snapshot before continuing. Do not request credentials in chat.

Browsers are headless. Open a window only for a bot check that refuses headless
Chromium. Close and relaunch that same browser using
`COGPIT_BROWSER_HEADED=1 agent-browser --session <name> open <url>`, let the user
pass the challenge, then wait for confirmation and snapshot again. Keep the
window for the task and close it when done. Private `tmp-` browsers cannot use
this escape: report the block to the parent.

Read [advanced.md](references/advanced.md) when reusing a verified browser for
HTTP requests, handling challenge responses, leaving browser notes or marking
up screenshots. Never export clearance cookies to other clients or profiles.

## Cogpit owns persistence

Do not pass `--profile`, `--state`, `--session-name`, `--args`, `--headed` or
`--cdp`. Use `--session` for routing; Cogpit handles the rest. These rules apply
on each device where the browser runs.

The Browser panel can change the viewport. For size-sensitive checks, use
`agent-browser set viewport <w> <h>` and verify again after a panel resize.

Show evidence in your reply, using an absolute path:

```markdown
![Page after the fix](/tmp/page.png)
```

A tool preview alone does not show it to the user. Record a flow with
`agent-browser record start /tmp/run.webm` and `agent-browser record stop`, then
show `![Flow](/tmp/run.webm)`.
