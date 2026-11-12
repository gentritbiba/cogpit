# Developing Cogpit

Cogpit uses Bun for development. Use Bun 1.3.14 to match CI. The npm launcher is a separate package with its own Node.js runtime requirements.

The server also needs its Rust core, `cogpit-core`. Install Rust with [rustup](https://rustup.rs); `rust-toolchain.toml` selects the version. `bun run dev`, `electron:dev`, `test` and `serve` build the core first with `bun run build:core`, and cargo makes repeat builds quick. See [the Rust core design](architecture/rust-core.md).

## Run locally

```bash
bun install
cd packages/cogpit-memory
bun install
cd ../..
bun run dev
```

For the desktop app (needs [Rust](https://rustup.rs) as well):

```bash
bun run desktop:dev
```

## Build and package

```bash
# Build the web app with production type checks
bun run build

# Build and serve the web app
bun run serve

# Build the desktop app for this machine (desktop/target/release/bundle)
bun run desktop:build
```

The desktop build is unsigned. [The desktop guide](desktop.md) explains how the app is put together. Signed release artifacts and in-app updates come from the [release workflow](../.github/workflows/release.yml).

## Check a change

The root and cogpit-memory have separate test suites. Install the package's development dependencies before running its checks.

```bash
bun run lint
bun run typecheck
bun run check:agents
bun run test
(cd desktop && cargo test)

cargo fmt --all --check
cargo clippy --all-targets -- -D warnings
cargo test

cd packages/cogpit-memory
bun test
```

On Bun 1.4.0-canary.1, the package's sqlite-backed `search-index.test.ts`, `commands/search.test.ts`, and `commands/index-cmd.test.ts` can report all tests passing and then crash during teardown. Run those files individually to read their results.

See [ARCHITECTURE.md](../ARCHITECTURE.md) for the agent layer and shared route registry, and the [plugin guide](plugins.md) for adding workspace panels.
