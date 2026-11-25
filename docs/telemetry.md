# Usage data

Cogpit sends anonymous usage data so we can see which agents, models and features people
actually use, and fix what gets in their way. It is on by default. This page lists everything it
sends, how it is handled, and [how to turn it off](#turn-it-off).

## What is sent

Every event carries:

- a random install ID, created on your computer and unrelated to you, your accounts or the machine
- the Cogpit version, edition, and how it runs (desktop app, npm launcher, or from source)
- your operating system, its version to two parts, the processor architecture, and whether it
  runs under WSL
- your language and timezone settings
- your country, region (state or province) and continent

The events themselves:

| Event | When | What it adds |
|---|---|---|
| `app.heartbeat` | When Cogpit starts, then once a day | Whether this is a new install, and the default agent |
| `session.started` | You or an agent start a session in Cogpit | Agent, model, effort, permission mode, fast mode, whether it runs in a worktree, and which kind of client started it (desktop, browser, phone, agent) |
| `message.sent` | A message reaches a session | The same, plus whether it started a turn or joined one |
| `turn.completed` | A turn in a session you started or messaged from Cogpit finishes | Agent, model, effort, how long it took, its input, output, cache and reasoning tokens, whether it ran in fast mode, how many tool calls it made and how many failed, lines added and removed, how many subagents it started, whether it compacted, whether a skill, plugin or MCP server took part (never which one), and how many images you attached |
| `tool.used` | With each finished turn | For each tool the turn used: the tool's name, how often it was called and how often it failed. Only names the agents ship, such as `Bash` or `apply_patch`, are sent; an MCP server's tool counts as `mcp` and any other tool as `other` |
| `agent.status` | A couple of minutes after Cogpit starts, then once a day | For each agent: whether it is installed, whether you are signed in, and its version number |
| `agent.error` | An agent fails to start or a turn fails | The agent, whether it was the start or a turn, the kind of failure (such as not installed, not signed in, or a model that is not available) and its HTTP status code |
| `usage.daily` | Once a day, for the day before | For each agent and model: input, cached input, cache write, output and reasoning tokens, number of responses and sessions, and the estimated cost |
| `feature.used` | You use a feature such as branching a session, answering a permission, sharing a session, opening the Browser panel, saving settings, managing automations or worktrees, or a `cogpit-session` command | The feature's name and which kind of client used it |

Token counts and turns cover only sessions you started or messaged from Cogpit, never agent
work you ran elsewhere. They start from the day Cogpit first sent usage data and are never sent
for days before it.

Model names are sent only when they are a vendor's public model name, such as
`claude-opus-5-5` or `gpt-5.5-codex`. Any other name, for example a local or fine-tuned model,
is sent as `other`.

## What is never sent

- prompts, replies, tool inputs or their output
- code, file contents, file or folder names, paths, project or repository names, branch names
- session IDs, titles or anything you typed
- error messages: a failure is sent only as its kind
- the names of skills, plugins, MCP servers or their tools
- your name, email, account IDs for Claude, OpenAI, GitHub or any other service
- your computer's name or user name
- your IP address

Values are checked before they leave: an event property can only be a number, a yes or no, or
a short word such as a model name. Anything else is dropped.

## Where it goes

Cogpit sends events to `telemetry.cogpit.dev`, a service Cogpit runs on Cloudflare. It reads
your country and region from Cloudflare's view of the connection, keeps a copy of each event,
and forwards the events to PostHog for analysis. It never stores or forwards your IP address,
and PostHog's own location lookup is turned off. Events are anonymous: PostHog keeps no person
profile for them.

## Turn it off

Set `COGPIT_TELEMETRY=0`, or the common `DO_NOT_TRACK=1`, in the environment Cogpit starts in.
While it is off Cogpit sends nothing and writes no usage data file.

- **Desktop app:** set it where the app can see it. On macOS and Linux that is your login
  environment, such as `~/.profile`, then log out and in again, or start the app from a terminal
  that has it. On Windows, add it as a user environment variable.
- **`npx cogpit` or a headless server:** set it in the shell or the service unit, for example
  `COGPIT_TELEMETRY=0 npx cogpit`.

Development builds, test runs and CI never send anything. `COGPIT_TELEMETRY=1` lets a
development build send, for testing.

Each device in a multi-device hub follows its own environment and sends its own data.

## Files

The install ID is stored in `telemetry.json` in Cogpit's data folder. It also
remembers which sessions you used from Cogpit and when their last reported turn started, so
their tokens and turns are counted once. That list never leaves your computer, and entries
older than 45 days are dropped. Deleting the file gives the
install a new ID.
