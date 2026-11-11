/**
 * Build the cogpit-core sidecar the server spawns.
 *
 *   bun run build:core             # target/debug/cogpit-core
 *   bun run build:core --release   # target/release/cogpit-core
 *
 * Cargo builds incrementally, so running this before every `dev` and `test`
 * costs a moment once the first build is done. Honors CARGO_TARGET_DIR.
 */
import { root } from "./lib/sourceFiles"

const release = process.argv.includes("--release")
const unknown = process.argv.slice(2).filter((arg) => arg !== "--release")
if (unknown.length > 0) {
  console.error(`build:core: unknown argument ${unknown.join(" ")} (only --release is accepted)`)
  process.exit(2)
}

if (!Bun.which("cargo")) {
  console.error(
    "build:core: cargo was not found. Cogpit's server needs its Rust core: install the toolchain from "
    + "https://rustup.rs (rust-toolchain.toml picks the version), then run this again.",
  )
  process.exit(1)
}

const result = Bun.spawnSync(
  ["cargo", "build", "--locked", "-p", "cogpit-core", ...(release ? ["--release"] : [])],
  { cwd: root, stdout: "inherit", stderr: "inherit" },
)
process.exit(result.exitCode ?? 1)
