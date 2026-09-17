# @cogpit/plugin-ui

Browser-safe Cogpit UI primitives, shared panel parts, time formatting and standalone Markdown descriptions. Components are the canonical implementations used by both the application and runtime plugins; application imports re-export them.

Import components from the package root or an exported component subpath, and import `@cogpit/plugin-ui/styles.css` in a plugin's stylesheet. The stylesheet provides Tailwind utilities and system fonts. The host's public theme tokens can override the defaults. `theme.css` exposes shared theme/base styles for application composition.

React and React DOM are peers. A runtime plugin bundles its own React and UI dependencies into its single executable entry. The package has no host authentication, session, Electron, Node or workspace imports. Markdown descriptions render images as text and send HTTPS links through the supplied `openExternal` callback.

Build JavaScript and self-contained NodeNext declarations with `bun run build`.
