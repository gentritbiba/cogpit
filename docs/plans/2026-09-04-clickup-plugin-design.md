# ClickUp plugin

A compile-time workspace panel (`plugins/clickup/`) that shows the signed-in
user's ClickUp tasks and, optionally, the tasks of one ClickUp list linked to
the current Cogpit project.

## Why not the GitHub shape

The GitHub and Vercel plugins borrow authentication from a CLI on the host and
derive their scope from the project (`origin` remote, `.vercel/project.json`).
ClickUp has neither: no CLI, and a task's home is a list in a workspace
hierarchy that has nothing to do with the project directory. So the plugin
owns its credential and its project mapping.

## Auth and storage

- Personal API token (`pk_…`), pasted once into a setup screen in the panel.
- Saved by the server to `~/.cogpit/clickup.json` (mode 600), next to
  `push.json`. `COGPIT_CLICKUP_TOKEN` or `CLICKUP_API_TOKEN` overrides it for
  headless boxes.
- The token never returns to the renderer. `GET /api/clickup/status` reports
  `{ configured, tokenFromEnv, viewer, workspace }` — the `tokenFromEnv` flag
  tells the panel whether the token came from the environment (readonly) or was
  manually configured.
- The same file carries `projects: { [projectPath]: listId }` — the per-project
  list link, set from the panel.

## Server (`server/routes/clickup.ts`)

Thin client over ClickUp REST v2 (`https://api.clickup.com/api/v2`), one
`fetch` per call, 20s timeout, responses parsed defensively into the contract
in `shared/contracts/clickup.ts`.

| Route | Purpose |
| --- | --- |
| `GET  /api/clickup/status` | configured?, viewer (id, username), workspace |
| `POST /api/clickup/token` | `{ token }` → verify with `/user`, persist |
| `DELETE /api/clickup/token` | forget the token |
| `GET  /api/clickup/tasks/mine` | tasks assigned to the viewer, open only, up to 3 pages |
| `GET  /api/clickup/tasks/list?cwd=` | tasks of the project's linked list, open + recently closed |
| `GET  /api/clickup/spaces` | spaces of the workspace |
| `GET  /api/clickup/lists?spaceId=` | folders (with lists) + folderless lists of a space |
| `PUT  /api/clickup/project-list` | `{ cwd, listId }` → link; `listId: null` unlinks |

Error codes: `clickup_not_configured`, `clickup_auth_failed`,
`clickup_api_failed`, `clickup_rate_limited`, `invalid_response`,
`project_unlinked`.

Task contract keeps what the rows need: id, customId, name, description
(markdown), status `{ name, type, color }`, priority, due/start/updated as
epoch ms, assignees, tags, list/folder/space names, url, parent, subtask
count is not fetched.

## Panel

Header like GitHub's: title, workspace name link, refresh, close.
Two tabs:

- **Mine** — workspace-wide tasks assigned to the viewer. Filter chips:
  status (derived from the data, ordered by ClickUp `orderindex`), due
  (overdue · today · this week · none), priority. Text search box filters
  name/list/folder client-side.
- **Project** — the linked list. Unlinked: paste a ClickUp list URL/id or
  browse space → folder → list. Linked: same chips plus a `ClosedFold` for
  recently closed tasks, and an "Unlink" affordance.

Row: status rail colour, name, custom id, list › folder breadcrumb, due
date (red when overdue), priority flag, assignees. Expanding shows the
description, tags, "Add to prompt" (composes a prompt with name, id, url and
description) and "Open in ClickUp".

Indicator on the activity rail: count of overdue tasks assigned to me.

## Store

Same external-store shape as `githubStore.ts`: keyed resources, 8s cache
window, background polling (60s), setup errors do not poll. Mutations (token,
link) call the API then force-refresh the affected resources.

## Testing

- Route tests with a mocked `clickupApi` dependency: parsing, pagination,
  error mapping, token persistence in a temp `HOME`.
- Store test: setup error does not poll.
- Panel tests: setup screen → token submit; Mine filters; Project link flow.
