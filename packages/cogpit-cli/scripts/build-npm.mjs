#!/usr/bin/env node
import { spawnSync } from "node:child_process"
import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
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
  entryPoints: { "cli-runtime": "src/cli.ts", "instance-worker": "../../server/agents/instanceWorker.ts" },
  outdir: "dist",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22.16",
  packages: "external",
  plugins: [{
    name: "bundle-plugin-packages",
    setup(builder) {
      builder.onResolve({ filter: /^@cogpit\/plugin-(?:contracts|integrations)(?:\/[^/]+)?$/ }, ({ path }) => {
        const [, directory, entry = "index"] = path.split("/")
        return { path: join(repoRoot, "packages", directory, "dist", entry + ".js") }
      })
    },
  }],

  sourcemap: false,
})

writeFileSync(join(outputDir, "cli.js"), `#!/usr/bin/env node
const [major, minor] = process.versions.node.split(".").map(Number)
if (major < 22 || (major === 22 && minor < 16)) {
  console.error("Cogpit requires Node.js 22.16 or newer. Please upgrade Node.js.")
  process.exit(1)
}
await import("./cli-runtime.js")
`, { mode: 0o755 })
chmodSync(join(outputDir, "cli.js"), 0o755)
console.log("Built install-free Cogpit CLI, server, and web app")
