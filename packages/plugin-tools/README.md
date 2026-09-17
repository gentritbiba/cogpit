# Cogpit plugin tools

`cogpit-plugin` signs a built plugin directory into a `.cogpit-plugin` file that any Cogpit host installs through Plugins → Install from file. No Cogpit rebuild is involved: the host only needs to trust your publisher once.

Packages are signed with TUF metadata, the same format Cogpit uses for its bundled plugins. A development publisher owns four ed25519 role keys and a pinned root document. Hosts pin that root when an operator enrolls the publisher with its SHA-256 fingerprint, then verify every bundle offline against it.

```bash
# once: create a publisher (keep keys.json private, share the root and fingerprint)
cogpit-plugin keygen --publisher dev-alice --out ~/.cogpit/plugin-publishers/dev-alice.json

# each release: sign the built directory (plugin.json, plugin.js, plugin.css, icons, LICENSE, NOTICE)
cogpit-plugin pack ./dist --keys ~/.cogpit/plugin-publishers/dev-alice.json --out ./my-panel.cogpit-plugin

# iterating: --dev stamps the version as <version>-dev.<n> so every rebuild is a distinct signed target
cogpit-plugin pack ./dist --keys ... --out ... --dev

# re-sign an official package under your own namespace (id becomes dev-alice.<name>)
cogpit-plugin pack ./generated/runtime-plugins/cloudflare --keys ... --out ... --as dev-alice --dev
```

On the host: Plugins → Publishers, enter the publisher name, a label, the `.root.json` file and its fingerprint from a channel you trust, then Plugins → Install from file with the `.cogpit-plugin` file.

The key file records the metadata version counter and every target the publisher has signed. Each `pack` produces the next metadata version and keeps earlier targets listed, so hosts continue to trust retained versions for rollback. Signing the same version again with different bytes is refused: hosts treat that as a changed target and revoke it, so bump the version or use `--dev`. Bundle metadata expires after 365 days by default (`--expires-days`); versions a host has already verified keep working after that.

Development publishers must use the `dev-` namespace and are separate from official `cogpit` packages. Root rotation is not supported by this tool yet: a new root means enrolling a new publisher.

Inside this repository, `bun run plugins:pack <plugin>` builds `plugins/<plugin>` and signs it as `dev-<user>` with keys under `~/.cogpit/plugin-publishers/`, creating them on first use. Like the other `@cogpit/plugin-*` packages this one is an unpublished 1.0.0 workspace: outside the repository run it from a checkout (`bun packages/plugin-tools/src/cli.ts ...`) until the packages are published.
