import assert from "node:assert/strict"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { createRequire } from "node:module"

const root = resolve(import.meta.dir, "..")
const require = createRequire(join(root, "package.json"))
const external = await mkdtemp(join(tmpdir(), "cogpit-plugin-author-"))

function run(args: string[], cwd = external): string {
  const result = Bun.spawnSync(args, { cwd, env: { ...process.env, NODE_PATH: "" }, stdout: "pipe", stderr: "pipe" })
  assert.equal(result.exitCode, 0, `${args.join(" ")}\n${result.stdout}\n${result.stderr}`)
  return result.stdout.toString()
}

try {
  const tarballs: Record<string, string> = {}
  for (const directory of ["plugin-contracts", "plugin-sdk", "plugin-integrations", "plugin-ui"]) {
    const packageDir = join(root, "packages", directory)
    const manifest = JSON.parse(await readFile(join(packageDir, "package.json"), "utf8"))
    for (const entry of Object.values(manifest.exports) as (string | { types: string; import: string })[]) {
      if (typeof entry === "string") { assert.match(entry, /^\.\/[^/]+\.css$/); continue }
      assert.match(entry.types, /^\.\/dist\/.+\.d\.ts$/)
      assert.match(entry.import, /^\.\/dist\/.+\.js$/)
    }
    assert.match(manifest.exports["."].types, /^\.\/dist\/.+\.d\.ts$/)
    assert.match(manifest.exports["."].import, /^\.\/dist\/.+\.js$/)
    const archive = join(external, `${directory}.tgz`)
    run(["bun", "pm", "pack", "--filename", archive, "--ignore-scripts", "--quiet"], packageDir)
    tarballs[manifest.name] = `file:${archive}`
  }
  const dependencies = Object.fromEntries(["esbuild", "typescript", "react", "react-dom", "@types/react", "@types/react-dom"].map((name) => [name, (require(`${name}/package.json`) as { version: string }).version]))
  await writeFile(join(external, "package.json"), JSON.stringify({ name: "external-plugin-fixture", private: true, type: "module", dependencies: { ...dependencies, ...tarballs }, overrides: tarballs }))
  run(["bun", "install", "--ignore-scripts"])
  await writeFile(join(external, "tsconfig.json"), JSON.stringify({ compilerOptions: { strict: true, target: "ES2022", module: "ESNext", moduleResolution: "Bundler", lib: ["ES2022", "DOM"], noEmit: true, skipLibCheck: false }, include: ["*.ts"] }))
  await writeFile(join(external, "plain.ts"), `import { createPluginClient } from "@cogpit/plugin-sdk"
export function start(port: MessagePort) {
  const client = createPluginClient({ port, context: { project: null, theme: { mode: "dark", tokens: {} }, locale: "en", reducedMotion: false, visible: true } })
  document.body.textContent = "External plugin"
  void client.ready()
  void client.integrations.request({ integration: "github", operation: "pulls", limit: 10 })
  return client
}
`)
  await writeFile(join(external, "react.ts"), `import { createElement } from "react"
import { createRoot } from "react-dom/client"
import { start } from "./plain"
import { Button } from "@cogpit/plugin-ui/button"
import { parseTasksPage } from "@cogpit/plugin-integrations/normalizeClickUp"
import { cn } from "@cogpit/plugin-ui"
import type { ClickUpTask } from "@cogpit/plugin-integrations/clickup"
import type { GitHubPullSessionsResponse } from "@cogpit/plugin-integrations/github"
import type { VercelDeploymentsResponse } from "@cogpit/plugin-integrations/vercel"
import type { CloudflareDeploymentsResponse } from "@cogpit/plugin-integrations/cloudflare"
export type NativeData = GitHubPullSessionsResponse | VercelDeploymentsResponse | CloudflareDeploymentsResponse
export function mount(port: MessagePort) {
  const client = start(port)
  const tasks: ClickUpTask[] = parseTasksPage({ tasks: [], last_page: true }).tasks
  createRoot(document.body).render(createElement(Button, { className: cn("button") }, "Tasks: " + tasks.length))
  return client
}
`)
  await writeFile(join(external, "exports.mjs"), `import { createRequire } from "node:module"
const require = createRequire(import.meta.url)
for (const name of ["@cogpit/plugin-ui/styles.css", "@cogpit/plugin-ui/theme.css"]) require.resolve(name)
for (const name of ["@cogpit/plugin-ui/dist/utils.js", "@cogpit/plugin-integrations/src/clickup.ts"]) {
  try { require.resolve(name); throw new Error("Private package export exposed") }
  catch (error) { if (error.code !== "ERR_PACKAGE_PATH_NOT_EXPORTED") throw error }
}
`)
  run(["node", "exports.mjs"])
  run(["bun", "node_modules/typescript/bin/tsc", "-p", "tsconfig.json"])
  await writeFile(join(external, "build.mjs"), `import { build } from "esbuild"
import { writeFile } from "node:fs/promises"
for (const name of ["plain", "react"]) {
  const result = await build({ entryPoints: [name + ".ts"], bundle: true, platform: "browser", format: "iife", target: "es2022", outfile: name + ".js", metafile: true })
  if (Object.values(result.outputs ?? result.metafile.outputs).some(o => o.imports.some(i => i.external))) throw new Error("External runtime import")
  await writeFile(name + ".meta.json", JSON.stringify(result.metafile))
}
`)
  run(["bun", "build.mjs"])
  for (const name of ["plain", "react"]) {
    const code = await readFile(join(external, `${name}.js`), "utf8")
    const metadata = JSON.parse(await readFile(join(external, `${name}.meta.json`), "utf8")) as { inputs: Record<string, unknown> }
    for (const input of Object.keys(metadata.inputs)) {
      assert.ok(!input.includes(root) && !/(?:^|\/)\.\.\//.test(input), `Bundle includes a file outside the author directory: ${input}`)
      assert.ok(!/(?:^|\/)(?:shared\/session|server|electron)\//.test(input), `Bundle imports host source: ${input}`)
    }
    assert.ok(code.length > 100)
  }
  console.log("Plugin packages type-check and build outside the repository with plain and React consumers")
} finally {
  await rm(external, { recursive: true, force: true })
}
