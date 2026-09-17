# GitHub panel

The versioned `cogpit.github` package contains Cogpit's existing Actions, Pull Requests and Issues tabs. The runtime entry supplies a scoped SDK client to the same UI components.

GitHub data uses the host's existing `gh` CLI authentication and the selected project's GitHub origin. The package can request only its declared read operations. It receives no host paths, CLI credentials or session filenames. Session navigation uses opaque host-issued handles; external links and issue drafts go through host permission checks.

Run `bun run typecheck` from this directory. The root runtime-plugin build creates the independent browser IIFE, stylesheet and immutable package archive, checking that its imports use public plugin packages. Install, enable, disable and version changes use the host plugin manager.

The host wrapper owns the close control. Hidden panels stop polling; disposal cancels pending requests and clears the frame's cache. Existing filters, expandable job/file details and session chips remain in the original components.
