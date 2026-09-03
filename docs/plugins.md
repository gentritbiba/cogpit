# Compile-time UI plugins

Cogpit plugins can contribute panels to the right workspace rail. Plugins are bundled with the app at build time; runtime installation and activation are not supported yet.

The repository includes two first-party plugins:

- `plugins/github-actions` uses GitHub CLI on the Cogpit host to show recent workflow runs, jobs, and steps. Install `gh`, then run `gh auth login` once.
- `plugins/vercel-deployments` uses Vercel CLI 50.5.1 or newer to show recent deployments and on-demand build output for the project linked at the exact active-session root. Run `vercel login` and `vercel link` once. It only uses the read-only `vercel api` command; it never deploys, promotes, redeploys, or rolls back.

If a required CLI is missing, outdated, or signed out, its panel shows setup guidance without affecting the rest of Cogpit.

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

- `context`: the current session, project path, file-change state, host-file capability, and worktree availability
- `active`: whether the panel is currently visible
- `closePanel()`: close the right workspace
- `openPanel(id)`: open another fully qualified panel ID

A panel definition may also set:

- `order`: activity-rail order; the default is `100`
- `defaultSize`, `minSize`, and `maxSize`: panel sizing with explicit CSS units
- `keepAlive`: retain component state while another panel is selected
- `when(context)`: hide the panel when it does not apply
- `badge(context)`: show a short count or status on the rail icon
- `indicator`: render a live status component on the rail icon for data that cannot be derived synchronously from panel context

Plugins may import shared contracts from `shared/` and the sanctioned application surface from `@/plugin-api`. The architecture check rejects direct imports into the rest of `src/`, which keeps plugins isolated from private implementation details.

The public API also exports `FilterChip` and `FilterChipCount` for the compact filter controls shared by the bundled panels.

The first extension point is intentionally limited to right-workspace UI. The bundled GitHub Actions and Vercel Deployments plugins use core routes registered by Cogpit itself; third-party plugins cannot contribute backend routes yet. Runtime plugin loading, plugin settings, backend route contributions, and bottom-bar contributions remain future work.
