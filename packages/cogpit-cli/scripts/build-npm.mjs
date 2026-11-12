#!/usr/bin/env node
import { spawnSync } from "node:child_process"
import { chmodSync, cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs"
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
  console.error(\`Cogpit needs Node.js 22.16 or newer. This computer has \${process.version}. Get the latest from https://nodejs.org\`)
  process.exit(1)
}
await import("./cli-runtime.js")
`, { mode: 0o755 })
chmodSync(join(outputDir, "cli.js"), 0o755)

// dist/core/<platform>-<arch>/cogpit-core: every target's binary when a release
// hands them over in COGPIT_CORE_DIST (same layout), else this checkout's own build.
const coreDir = join(outputDir, "core")
const coreName = (platform) => platform.startsWith("win32") ? "cogpit-core.exe" : "cogpit-core"
function shipCore(platform, binary) {
  const target = join(coreDir, platform, coreName(platform))
  mkdirSync(dirname(target), { recursive: true })
  cpSync(binary, target)
  chmodSync(target, 0o755)
}
const prebuilt = process.env.COGPIT_CORE_DIST?.trim()
if (prebuilt) {
  for (const platform of readdirSync(prebuilt)) shipCore(platform, join(prebuilt, platform, coreName(platform)))
} else {
  const targetDir = process.env.CARGO_TARGET_DIR?.trim() ? resolve(process.env.CARGO_TARGET_DIR) : join(repoRoot, "target")
  const [newest] = ["release", "debug"]
    .map((profile) => join(targetDir, profile, coreName(process.platform)))
    .filter((binary) => existsSync(binary))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)
  if (!newest) throw new Error(`No cogpit-core build under ${targetDir}. Run \`bun run build:core\` first.`)
  shipCore(`${process.platform}-${process.arch}`, newest)
}
console.log("Built install-free Cogpit CLI, server, and web app")
