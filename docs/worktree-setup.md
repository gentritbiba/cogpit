# Worktree setup

Worktree setup is an optional plugin, `cogpit.worktree-setup`, bundled with Cogpit but not installed. Install it from Plugins → Browse. Until it is installed and enabled, Cogpit neither reads nor runs any saved setup command, including commands saved by earlier releases.

## Using the plugin

Open **Worktree setup** in the sidebar to configure a project setup command. Project scripts can fill the command field; they never run just because a repository declares them. **Review and save** opens Cogpit's own dialog, which shows the exact command and timeout. The command is saved only after you tick the trust box there. Clear the command to disable setup. A recipe trusts the command and the project code it invokes, including package-manager lifecycle scripts.

Recipes belong to the current account on the selected host and the canonical Git project. Linked worktrees share that project's recipe; another account or Git project does not. Configuration and bounded startup history live in the host's Cogpit data directory (`worktree-setup/`), outside tracked project configuration. Disabling or uninstalling the plugin keeps them; reinstalling uses them again.

Setup runs in the directory reported by native initialization, before the first provider input is released. A failed setup keeps the first prompt waiting and retains the worktree, output and exit code. Fix the command or project, then choose **Retry setup** in the plugin. **Cancel startup** stops the command and its descendants, ends startup and retains the checkout. Each operation retains at most 64,000 output characters. History keeps the latest 20 operations, plus active ones. Commands default to a ten-minute timeout (up to one hour). The whole startup, including waiting for a retry, expires after two hours.

## Boundary

Session creation owns generic readiness in `server/sessionStartup/`: worktree initialization, path validation, `prepare` (PR review pins a commit), the caller's authority checks, cancellation and expiry. It offers one optional step, `registerWorktreeStartupStep`. The plugin manager registers the release-owned integration in `server/plugins/integrations/worktreeSetup/`. For each startup the integration asks the manager for a grant: an enabled plugin with release or official provenance, the `worktreeSetup` integration permission, a scope covering the project, and no safe mode. It asks again before every command. Disabling, updating or uninstalling the plugin aborts its running recipes, and their startups end without releasing the first prompt.

A plugin frame reaches recipes only through the `worktreeSetup` integration operations `snapshot`, `scripts`, `propose` and `act`, each re-checking host-file and terminal access. `propose` stores a short-lived proposal. Only Cogpit's confirmation dialog saves it, through `POST /api/plugins/leases/:id/worktree-setup-confirm`. Snapshots carry no host paths or session ids.

While a worktree startup is holding its first prompt, the new-session view shows a small status with **Cancel startup** (`GET /api/session-startups`). Nothing about setup appears when no startup is running.

`createSession` is the integration entry point for interactive, CLI, review and automation callers. Worktree requests await readiness before returning the initialized cwd. Account-aware or delayed callers must supply `authorizeStartup`, which revalidates the current request or execution grant before preparation and the first provider prompt; they also supply the owner's `setupScope` (or `retry.scope`). Independent sends to a session still waiting for readiness return busy.
