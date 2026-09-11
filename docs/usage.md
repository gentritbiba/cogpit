# Using Cogpit

[Install Cogpit](../README.md#get-started), then select a project and a session. Cogpit reads existing CLI history and connects to the agent runtime when you start or continue work.

## Agent support

Start sessions with Claude Code, OpenAI Codex, or GitHub Copilot CLI. Model options come from the installed CLIs. Cogpit shows reasoning effort, image input, and speed controls when the selected provider and model support them.

| Control | Claude Code | OpenAI Codex | GitHub Copilot CLI |
| --- | --- | --- | --- |
| Start and resume sessions | Yes | Yes | Yes |
| Model selection | Yes | Yes | Yes |
| Approvals and questions | Yes | Yes | Yes |
| Branch and rewind | Cogpit history controls | Cogpit history controls | Native fork and rewind |
| Redo | Yes | Yes | No |
| Goals | Native goal lifecycle | Goals with optional token budgets | No |
| Guest session sharing | Yes | No | No |
| MCP server selector | Yes | No | No |

Codex uses a persistent app-server connection for native threads, turns, steering, interruption, goals, and approvals. Older installations can use a legacy CLI fallback. If a requested Codex model is unavailable, Cogpit reports the fallback and retries with the provider default.

Copilot discovery reads events from `~/.copilot/session-state`. It does not import VS Code Copilot Chat history. Copilot timelines include recorded nested agent activity, file changes, pull request links, and available usage data. Cogpit does not expose Copilot goals, workflows, or MCP editing. You can browse its instructions, settings, and skills in the configuration editor.

## Sessions and conversation history

The sidebar and mobile Sessions tab show live and recent sessions, with status and attention cues. Search by project, prompt, title, branch, or pull request. Enter `#157`, a project name plus `#157`, or a GitHub pull request URL to find sessions that created or worked on that PR. Focus the sidebar on a single project using the scope picker below the search box to see only that project's sessions as cards with more detail; select "All projects" to return to the grouped view.

Archive a finished session to keep the sidebar short: hover a row and use the archive button, or right-click it. A project header's menu archives every idle session in that project at once. Archiving only hides the session from the list; the transcript is untouched, and the toast offers Undo. The archive toggle next to the search box lists archived sessions again, dimmed with an archive mark, and a search always looks through them. Archived sessions come back on their own when they get new activity, including a message sent from Cogpit. Sessions with no activity for two weeks are archived automatically; restoring one keeps it listed until you archive it again. The archive is stored on the server, so every device sees the same list.

The timeline contains messages, expandable thinking blocks, tool calls, diffs, and compaction markers. Expand a command to inspect its output. Adjacent shell calls share a card, and failures stay attached to the command that produced them.

Work stays expanded while a turn is live. Completed turns fold behind a duration row. Each turn has a separate file summary. Cogpit virtualizes long transcripts so you can scroll through large sessions.

Claude token streaming is on by default. Set `COGPIT_STREAM_PARTIAL=0`, `false`, `off`, or `no` before launching Cogpit to disable partial messages while keeping completed session updates.

## Messages, models, and permissions

The model chip beside Send opens the provider, model, reasoning effort, and available speed controls. You can change several settings before clicking outside to close it. Image drag-and-drop and paste appear for models that accept images. Slash command suggestions come from supported project skills and commands.

On capable Claude models, Ultracode sets XHigh effort and standing multi-agent orchestration for the current session. It is off until you enable it and does not carry into another session.

Full access is the default permission mode. Choose a more restrictive profile to require approvals or limit operations. Native approval requests show the command or operation and the decisions the runtime accepts. Codex requests from nested subagents also appear in the composer.

For Claude sessions, the MCP selector lets you filter available servers and enable or disable them for the session. Other CLIs use their own configuration.

## Goals and subagents

Set a persistent goal above the composer to track progress, token usage, elapsed time, and available evaluator feedback. Codex goals can use token budgets and pause or resume controls. Claude goals follow Claude Code's native lifecycle.

The session details panel shows recorded subagent status, task, duration, and tool count when the provider exposes them. Agent activity also stays attached to the parent conversation. Available transcript inspection differs by CLI.

## File changes, branching, and rewind

The file changes panel offers a combined diff for the session or a chronological view of individual edits. Filter by turn and group changes by subagent. You can open files in your editor or inspect their git diffs.

Claude Code and Codex sessions use Cogpit's history graph and file-operation reversal for undo, redo, and branches. Copilot uses native fork and rewind, with optional file restoration and no redo. Review the restoration controls before rewinding work.

The Worktrees panel in the right rail lists active git worktrees, whether they have uncommitted changes, commits ahead, and linked sessions. It also offers PR creation and cleanup controls.

## Browser, terminal, and file editor

The [Browser panel](browser.md) shows the browser your agent is using. Select the same browser and tab to watch it work or interact with the page yourself. The shared default browser retains logins. Named browsers keep separate profiles, and subagents use private temporary browsers.

On desktop, terminals and discovered project scripts share the bottom process panel. Select terminal output to add it to the chat composer.

The project file editor reads and writes files within the project, checks modification times to avoid overwriting concurrent edits, and previews supported content. Use `@` in the composer to mention a file.

Enable **Configuration → Open files in Cogpit** to route file links, file-change cards, and open-in-editor actions to the built-in editor. On remote devices, it reads the file through the hub proxy.

## Usage and process monitoring

Session analytics show available input, output, cache, and context usage, plus tool counts, errors, and duration. Cost estimates use published model prices. If a GPT model has no published USD price, Cogpit leaves cost unavailable. Account plan, credit, and rate-limit data appears where the provider exposes it.

The header performance monitor shows CPU, memory, event-loop, stream, and API activity. The desktop app also breaks down Electron process usage. It polls while open.

The process leak monitor flags suspected orphaned agents, browsers, and scripts, with CPU usage, age, and severity. On macOS and Linux, Cogpit automatically cleans up orphaned agent session trees only after they are at least 30 minutes old and appear in two consecutive sweeps. Review and clean up other suspected leaks from the monitor.

## Notifications

Cogpit raises notifications when an agent finishes or needs an answer, including sessions started in a terminal. The notification inbox persists in `~/.cogpit/notifications.json`. Open the bell in the header, or read `GET /api/notifications`.

Desktop notifications use the Cogpit icon and open the relevant session when clicked. They are suppressed when the window is focused and already showing that session. A headless server falls back to `osascript` on macOS. Other headless systems use push notifications.

### Phone push with ntfy

Phone push goes through [ntfy](https://ntfy.sh) when the desktop is unattended: no window, a locked or suspended screen, or 120 seconds without system keyboard or mouse input. Headless servers count as unattended.

Create `~/.cogpit/push.json` with permissions `0600`. Keep the topic private because anyone who knows it can read its notifications.

```json
{ "topic": "your-private-topic", "publicUrl": "https://cogpit.example.com" }
```

| Key | Environment override | Default | Purpose |
| --- | --- | --- | --- |
| `topic` | `COGPIT_NTFY_TOPIC` | Unset | Enables push. Topic must use `[-_A-Za-z0-9]` and be at most 64 characters. |
| `ntfyUrl` | `COGPIT_NTFY_URL` | `https://ntfy.sh` | ntfy server URL. Self-hosted servers work too. |
| `token` | `COGPIT_NTFY_TOKEN` | Unset | Bearer token for a protected topic. |
| `publicUrl` | `COGPIT_PUBLIC_URL` | Unset | Reachable Cogpit URL for notification links. Without it, pushes have no click target. |

Changes take effect without restarting. Headless services can use the environment variables instead of a config file. No agent notification hooks are required.

## Remote access and multiple devices

Enable Network Access to connect from another device. Remote browser access requires HTTPS. A non-loopback bind requires a network password of at least 16 characters. The [self-hosting guide](self-hosting.md) covers TLS proxies, forwarding headers, password policy, and session expiry.

The device switcher shows one machine at a time and restores the view you left on each device. Use `Cmd+Shift+1–9` or `Ctrl+Shift+1–9` to select a machine, and `Cmd+Shift+0` or `Ctrl+Shift+0` to cycle.

Under **Devices → Add device**, enter the address of a Cogpit app with Network Access enabled or a headless server. Use its network password for personal edition, or a username and password for team edition. Cogpit checks connectivity, authentication, bootstrap state, and version differences. The hub proxies traffic to the selected device.

To run a headless box from source:

```bash
COGPIT_HOST=0.0.0.0 COGPIT_NETWORK_PASSWORD='your-long-passphrase' bun server/standalone.ts
```

Put HTTPS in front of it for remote browser access. Local-only actions such as revealing a folder or opening an external terminal are hidden when viewing a remote machine.

Claude Code sessions can be shared with a guest through a passphrase-protected link. The guest gets access to that session. Manage active shares in **Configuration → Network**.

## Configuration, integrations, and shortcuts

Browse and edit the installed CLIs' instruction files, settings, and skills at global and project scope. Commands, agents, themes, and MCP configuration appear for CLIs that support them. Cogpit writes changes to disk when you save.

GitHub, ClickUp, and Vercel panels are read-only integrations. GitHub uses your authenticated `gh` CLI for Actions, pull requests, and issues. ClickUp uses a personal API token and supports a linked list per project. Vercel uses CLI 50.5.1 or newer and the project linked at the exact session root. The [plugin guide](plugins.md) covers setup and the compile-time API for custom panels. Runtime plugin installation is not supported.

Press `Cmd+K` to open the command palette. Customize shortcuts in settings, with conflict detection. Cogpit includes Dark, Deep OLED, and Light themes.
