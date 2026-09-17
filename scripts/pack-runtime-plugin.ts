import { spawnSync } from "node:child_process"
import { homedir } from "node:os"
import { join, resolve } from "node:path"
import { main } from "../packages/plugin-tools/src/cli"

const root = resolve(import.meta.dir, "..")
const args = process.argv.slice(2)
const name = args.find((argument) => !argument.startsWith("--"))
const flag = (key: string) => { const index = args.indexOf(`--${key}`); return index === -1 ? undefined : args[index + 1] }
if (!name || args.includes("--help")) {
  console.log(`Usage: bun run plugins:pack <plugin> [--as dev-<name>] [--keys <keys.json>] [--out <file>] [--release]

Builds plugins/<plugin> and signs it for Plugins → Install from file.
  --as     development publisher to sign as (default: dev-<your user name>)
  --keys   publisher key file (default: ~/.cogpit/plugin-publishers/<publisher>.json, created on first use)
  --out    output package (default: artifacts/plugins/<plugin>.cogpit-plugin)
  --release keep the manifest version instead of appending -dev.<n>`)
  process.exit(name ? 0 : 1)
}
/** Publisher names are `dev-` plus lowercase letters, digits and dashes, so fold the host user name into that shape. */
function defaultPublisher(): string {
  const user = (process.env.USER ?? "local").toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "")
  return `dev-${user || "local"}`
}
const publisher = flag("as") ?? defaultPublisher()
const keys = resolve(flag("keys") ?? join(homedir(), ".cogpit", "plugin-publishers", `${publisher}.json`))
const out = resolve(flag("out") ?? join(root, "artifacts", "plugins", `${name}.cogpit-plugin`))

const build = spawnSync("bun", ["scripts/build-runtime-plugins.ts", name], { cwd: root, stdio: "inherit" })
if (build.status !== 0) process.exit(build.status ?? 1)
if (!(await Bun.file(keys).exists())) {
  const created = await main(["keygen", "--publisher", publisher, "--out", keys])
  if (created !== 0) process.exit(created)
  console.log("Enroll this publisher once per host: Plugins → Publishers, using the root file and fingerprint above.")
}
process.exitCode = await main(["pack", join(root, "generated", "runtime-plugins", name), "--keys", keys, "--out", out, "--as", publisher, ...(args.includes("--release") ? [] : ["--dev"])])
