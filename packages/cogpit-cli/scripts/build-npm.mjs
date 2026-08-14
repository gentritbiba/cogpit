#!/usr/bin/env node
import { spawnSync } from "node:child_process"
import { chmodSync, mkdirSync, rmSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { build } from "esbuild"

const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const repoRoot = resolve(packageDir, "../..")
const outputDir = join(packageDir, "dist")
const webDir = join(outputDir, "web")

rmSync(outputDir, { recursive: true, force: true })
mkdirSync(outputDir, { recursive: true })

const webBuild = spawnSync(
  "bun",
  ["run", "build:web", "--outDir", webDir, "--emptyOutDir"],
  { cwd: repoRoot, encoding: "utf8", stdio: "inherit" },
)
if (webBuild.status !== 0) {
  throw new Error(`Cogpit web build failed with exit code ${webBuild.status ?? "unknown"}.`)
}

await build({
  absWorkingDir: packageDir,
  entryPoints: ["src/cli.ts"],
  outfile: "dist/cli.js",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20.11",
  packages: "external",
  banner: { js: "#!/usr/bin/env node" },
  sourcemap: false,
})

chmodSync(join(outputDir, "cli.js"), 0o755)
console.log("Built install-free Cogpit CLI, server, and web app")
