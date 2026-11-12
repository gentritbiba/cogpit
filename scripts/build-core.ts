/**
 * Build cogpit-core, the Rust process the server runs beside itself.
 *
 *   bun run build:core                     # target/debug/cogpit-core
 *   bun run build:core --release           # target/release/cogpit-core
 *   bun run build:core --release --stage   # …and copy it to core-dist/<platform>-<arch>/
 *
 * Cargo builds incrementally, so running this before every `dev` and `test`
 * costs a moment once the first build is done. Honors CARGO_TARGET_DIR.
 * `core-dist/` is where the packaged apps take the binary from: electron-builder
 * (`extraResources`) and, in a release, the npm package (`COGPIT_CORE_DIST`).
 */
import { chmodSync, copyFileSync, mkdirSync } from "node:fs"
import { join, resolve } from "node:path"
import { CORE_BINARY_NAME } from "../server/core/binary"
import { root } from "./lib/sourceFiles"

const FLAGS = ["--release", "--stage"]
const args = process.argv.slice(2)
const unknown = args.filter((arg) => !FLAGS.includes(arg))
if (unknown.length > 0) {
  console.error(`build:core: unknown argument ${unknown.join(" ")} (accepted: ${FLAGS.join(", ")})`)
  process.exit(2)
}
const release = args.includes("--release")
const stage = args.includes("--stage")
if (stage && !release) {
  console.error("build:core: --stage ships the binary in an app, so it needs --release")
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
if (result.exitCode !== 0) process.exit(result.exitCode ?? 1)

if (stage) {
  const targetDir = process.env.CARGO_TARGET_DIR?.trim() ? resolve(process.env.CARGO_TARGET_DIR) : join(root, "target")
  const stagedDir = join(root, "core-dist", `${process.platform}-${process.arch}`)
  mkdirSync(stagedDir, { recursive: true })
  copyFileSync(join(targetDir, "release", CORE_BINARY_NAME), join(stagedDir, CORE_BINARY_NAME))
  chmodSync(join(stagedDir, CORE_BINARY_NAME), 0o755)
  console.log(`build:core: staged ${join(stagedDir, CORE_BINARY_NAME)}`)
}
