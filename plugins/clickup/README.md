# ClickUp runtime package

`runtime.tsx` is the independent entry. The bundle installs `globalThis.cogpitPlugin({ port, context, assets })`, creates its own React root and uses `@cogpit/plugin-sdk`. It imports only this package and public dependencies. `plugin.json` and `connections/clickup.json` are signed package inputs; `styles.css` uses the public UI stylesheet. The package is `cogpit.clickup` version `1.0.0`, with Plugin API `^1.0.0`. The current `>=2.6.6` client/host floor is for development; the first supported release floor remains to be assigned.

Connection credentials, workspace selection and project-to-list mappings belong to the parent Connections interface. The frame receives connection status and selected resource labels, then calls the declared `viewer`, `mine`, `list` and `tasks` operations. It never receives a token or constructs a host API request.

My tasks loads at most three pages. Project tasks combine at most three open pages with one page of closed tasks updated within fourteen days. The shared task display preserves custom IDs, priority/due/status/search filters, ordering, closed folding and draft formatting. Eight-second cache freshness and single-flight loads avoid duplicate requests; active resources poll, hidden frames pause, and changing project or closing the frame cancels outstanding work. Host-side leases separately enforce the active identity and scope.

Task, workspace, list and Markdown links use SDK navigation. Draft actions use `composer.append`. Markdown is standalone and renders remote images as text under the frame's CSP.

The runtime reuses the existing task list, filters and public UI components. Credentials and project links are managed by the trusted host Connections controls. Static registration and the old request store have been removed.
