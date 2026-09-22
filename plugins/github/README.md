# GitHub panel

The versioned `cogpit.github` package contains Cogpit's Actions, Pull Requests and Issues tabs, plus a **This session** tab that appears first whenever the open chat session opened or worked on pull requests in the repository. The runtime entry supplies a scoped SDK client to the same UI components.

GitHub data uses the host's existing `gh` CLI authentication and the selected project's GitHub origin. The package can request only its declared operations: the reads, and `mergePull`, the one write, which merges a pull request the user has confirmed inline and pins the merge to the head commit that was shown. It receives no host paths, CLI credentials or session filenames. Session navigation uses opaque host-issued handles; the open session arrives in `context.session` as the same kind of handle under the `session.identity` permission, which is how the panel picks out that session's pull requests. External links and issue drafts go through host permission checks.

Pull request rows show check progress as a ring that fills as each check on the head commit reports. Clicking it opens the Actions tab focused on the branch when a check comes from GitHub Actions, and the pull request's checks page on GitHub otherwise.

Run `bun run typecheck` from this directory. The root runtime-plugin build creates the independent browser IIFE, stylesheet and immutable package archive, checking that its imports use public plugin packages. Install, enable, disable and version changes use the host plugin manager.

The host wrapper owns the close control. Hidden panels stop polling; disposal cancels pending requests and clears the frame's cache. Existing filters, expandable job/file details and session chips remain in the original components.
