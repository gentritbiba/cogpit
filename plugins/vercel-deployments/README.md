# Vercel deployments runtime package

This package runs the existing Vercel right-sidebar panel as `cogpit.vercel` version 1.0.1. The display component and its production summary, filters, deployment rows and expandable build logs remain shared with their existing tests. React and the public plugin UI are bundled with the package.

The frame calls only the public SDK's `integrations.request` operations `deployments` and `buildLogs`, plus `navigation.openExternal` for links. It receives an opaque project identity and never chooses a workspace path or receives host authentication. The parent supplies the exact active-session workspace to the host integration. Vercel CLI authentication and `.vercel/project.json` remain on that host; the CLI must be at least 50.5.1. Build logs require a deployment identity matching the linked project before event retrieval.

The host finds the nearest link between the session directory and its Git worktree root, without searching sibling apps or other worktrees. Non-Git folders need their own link. Missing links are checked again every ten seconds while visible, without clearing the setup message during the check. Version 1.0.1 requires host 2.7.0 and client 2.6.6 or newer. Existing installations update through Plugins → Browse → Vercel Deployments → Review update.

Run `bun run build:runtime-plugins` from the repository to produce the standalone archive. `bun x tsc -p plugins/vercel-deployments/tsconfig.runtime.json` verifies the independent runtime source. The signed manifest source is `plugin.json`, runtime entry is `runtime.tsx`, and styles come from the public UI stylesheet.

`NOTICE` records the 17 third-party package versions and license texts in the rendered production module closure, including CSS dependencies. Regenerate it when that closure changes. The temporary notice-generation script was removed after checking the production build.
