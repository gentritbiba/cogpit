# Developing Cogpit

Cogpit uses Bun for development. Use Bun 1.3.14 to match CI. The npm launcher is a separate package with its own Node.js runtime requirements.

## Run locally

```bash
bun install
cd packages/cogpit-memory
bun install
cd ../..
bun run dev
```

For the Electron desktop app:

```bash
bun run electron:dev
```

## Build and package

```bash
# Build the web app with production type checks
bun run build

# Build and serve the web app
bun run serve

# Build a local unsigned macOS arm64 desktop package
bun run electron:package
```

`bun run electron:package:signed` uses a local Developer ID and builds the host targets. It requires a paid Apple Developer account and signing credentials. The [release workflow](../.github/workflows/release.yml) builds the distribution artifacts for each supported platform.

## Check a change

The root and cogpit-memory have separate test suites. Install the package's development dependencies before running its checks.

```bash
bun run lint
bun run typecheck
bun run check:agents
bun run test

cd packages/cogpit-memory
bun test
```

On Bun 1.4.0-canary.1, the package's sqlite-backed `search-index.test.ts`, `commands/search.test.ts`, and `commands/index-cmd.test.ts` can report all tests passing and then crash during teardown. Run those files individually to read their results.

See [ARCHITECTURE.md](../ARCHITECTURE.md) for the agent layer and shared route registry, and the [plugin guide](plugins.md) for adding workspace panels.
