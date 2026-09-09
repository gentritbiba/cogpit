# Compile-time UI plugins

Cogpit plugins can contribute panels to the right workspace rail. Plugins are bundled with the app at build time; runtime installation and activation are not supported yet.

The repository includes three first-party plugins:

- `plugins/github` uses GitHub CLI on the Cogpit host. Its Actions tab shows recent workflow runs, jobs, and steps; its Pull requests tab lists open pull requests (closed and merged ones fold away underneath) with check, review, conflict and comment signals, each description and changed-file list, the Cogpit sessions that worked on them, and links out to GitHub. Its Issues tab lists open issues (closed ones fold away) filtered by assignee, author or label, and can drop an issue into the message composer as a prompt. Install `gh`, then run `gh auth login` once.
- `plugins/vercel-deployments` uses Vercel CLI 50.5.1 or newer to show recent deployments and on-demand build output for the project linked at the exact active-session root. Run `vercel login` and `vercel link` once. It only uses the read-only `vercel api` command; it never deploys, promotes, redeploys, or rolls back.
- `plugins/clickup` talks to the ClickUp REST API with a personal API token. Its My tasks tab lists every open task assigned to you across the workspace, sorted overdue-first and filtered by due date, priority, status or free text; its This project tab shows one ClickUp list linked to the current project (paste the list URL or browse space → list), with recently closed tasks folded away. Any task can be dropped into the composer as a prompt. Paste the token (ClickUp → Settings → Apps) into the panel once; the server keeps it owner-only in `~/.cogpit/clickup.json` together with the project links and never returns it to the browser. `COGPIT_CLICKUP_TOKEN` or `CLICKUP_API_TOKEN` in the server environment overrides the file for headless boxes. The plugin is read-only.

If a required CLI or token is missing, outdated, or signed out, its panel shows setup guidance without affecting the rest of Cogpit.

## Add a panel

Create a plugin module under `plugins/`:

```tsx
// plugins/example/plugin.tsx
import { Puzzle } from "lucide-react"
import {
  Button,
  definePlugin,
  type WorkspacePanelProps,
} from "@/plugin-api"

function ExamplePanel({ context, closePanel }: WorkspacePanelProps) {
  return (
    <section className="flex size-full flex-col">
      <header className="flex h-10 items-center gap-2 border-b px-3">
        <h2 className="flex-1 text-sm font-medium">Example plugin</h2>
        <Button size="sm" variant="ghost" onClick={closePanel}>Close</Button>
      </header>
      <div className="p-3 text-sm">{context.projectPath}</div>
    </section>
  )
}

export default definePlugin({
  id: "example",
  workspacePanels: [{
    id: "panel",
    title: "Example plugin",
    icon: Puzzle,
    component: ExamplePanel,
    when: (context) => context.projectPath !== null,
  }],
})
```

Register it in `plugins/index.ts`, then rebuild Cogpit:

```ts
import example from "./example/plugin"
import type { CogpitPlugin } from "@/plugin-api"

export const plugins: readonly CogpitPlugin[] = [example]
```

```bash
bun run build
```

Plugin and panel IDs use lowercase letters, numbers, dots, and hyphens. Cogpit qualifies panel IDs as `<plugin-id>.<panel-id>` and rejects duplicate IDs during startup.

## Panel API

Each panel receives:

- `context`: the current session, project path, file-change state, host-file capability, worktree availability, plus `openSession(dirName, fileName)` and `composePrompt(text)` where the host can switch sessions or has a composer
- `active`: whether the panel is currently visible
- `closePanel()`: close the right workspace

A panel definition may also set:

- `order`: activity-rail order; the default is `100`
- `defaultSize`, `minSize`, and `maxSize`: panel sizing with explicit CSS units
- `keepAlive`: retain component state while another panel is selected
- `when(context)`: hide the panel when it does not apply
- `badge(context)`: show a short count or status on the rail icon
- `indicator`: render a live status component on the rail icon for data that cannot be derived synchronously from panel context

Plugins may import shared contracts from `shared/` and the sanctioned application surface from `@/plugin-api`. The architecture check rejects direct imports into the rest of `src/`, which keeps plugins isolated from private implementation details.

The public API also exports `FilterChip` and `FilterChipCount` for the compact filter controls shared by the bundled panels, `FilterBar`, `TabEmpty`, `ClosedFold` and `Description` for the list layout the bundled panels share, `relativeTime` and `useNow` for timestamps, `Tabs` for panels with more than one view, and `StreamingMarkdown` for rendering untrusted markdown such as pull request descriptions without syntax highlighting or image fetches.

The first extension point is intentionally limited to right-workspace UI. The bundled GitHub, ClickUp and Vercel Deployments plugins use core routes registered by Cogpit itself; third-party plugins cannot contribute backend routes yet. Runtime plugin loading, plugin settings, backend route contributions, and bottom-bar contributions remain future work.
