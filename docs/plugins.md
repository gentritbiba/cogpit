# Compile-time UI plugins

Cogpit plugins can contribute panels to the right workspace rail. Plugins are bundled with the app at build time; runtime installation and activation are not supported yet.

The repository includes `plugins/github-actions` as the first real plugin. It uses GitHub CLI on the Cogpit host to show recent workflow runs, jobs, and steps. Install `gh`, then run `gh auth login` once. If the CLI is missing or signed out, the panel shows setup guidance without affecting the rest of Cogpit.

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

- `context`: the current session, project path, file-change state, and host-file capability
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

The first extension point is intentionally limited to right-workspace UI. The bundled GitHub Actions plugin uses `/api/github-actions`, a core route registered by Cogpit itself; third-party plugins cannot contribute backend routes yet. Runtime plugin loading, plugin settings, backend route contributions, and bottom-bar contributions remain future work.
