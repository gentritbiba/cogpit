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

### Update your installed Mac app

```bash
bun run electron:update
```

This builds the current checkout, including uncommitted changes, and updates `/Applications/Cogpit.app`. It packages an app bundle directly, so there is no DMG to mount or drag into Applications. It uses your current Bun architecture and needs no Apple Developer membership. It does not fetch Git changes, publish a release, or change your app data.

If Cogpit is open, the command stages the build and leaves a detached installer waiting for you to quit with **Cmd+Q**. Closing the window alone does not quit the Mac app. After the app and its helpers exit, the installer replaces the bundle and reopens Cogpit. You can run the command from Cogpit's terminal; the installer survives the app quitting. If Cogpit is already closed, installation completes immediately.

Use `bun run electron:update --app "$HOME/Applications/Cogpit.app"` for a different installation directory. The directory must already exist and be writable without sudo. A second update command refuses to start while one is building or waiting. Installer output is appended to `~/.cogpit/local-update.log`. Temporary build files are removed after success; a failed replacement restores the previous bundle. If interrupted before replacement, rerunning the command clears the abandoned build. An interrupted replacement that leaves two app copies requires inspection before retrying.

Public macOS automatic updates still require the signed release setup. This command updates a trusted local checkout only.

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
