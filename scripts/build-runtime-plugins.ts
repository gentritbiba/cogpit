import { mkdir, readFile, readdir, writeFile, copyFile, realpath } from "node:fs/promises"
import { dirname, extname, join, relative, resolve, sep } from "node:path"
import { build, type Plugin } from "vite"
import react from "@vitejs/plugin-react"
import tailwindcss from "@tailwindcss/vite"
import { parseManifest } from "@cogpit/plugin-contracts"
import { inspectPackage, validatePackagePath } from "../server/plugins/package"

const root = resolve(import.meta.dir, "..")
const app = JSON.parse(await readFile(join(root, "package.json"), "utf8")) as { version: string }
const bundled = ["clickup", "cloudflare", "github", "vercel-deployments"]
const requested = process.argv.slice(2)
for (const name of requested) if (!bundled.includes(name)) throw new Error(`Unknown bundled plugin: ${name}`)
const names = requested.length ? requested : bundled
const seeds = []
const mime: Record<string, string> = { ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".md": "text/plain", ".txt": "text/plain" }

for (const name of names) {
  const source = join(root, "plugins", name)
  const output = join(root, "generated/runtime-plugins", name)
  const manifest = parseManifest(JSON.parse(await readFile(join(source, "plugin.json"), "utf8")))
  const allowed = await Promise.all([source, ...["plugin-contracts", "plugin-sdk", "plugin-ui", "plugin-integrations"].map((entry) => join(root, "packages", entry)), join(root, "node_modules")].map((path) => realpath(path)))
  const boundary: Plugin = { name: "plugin-public-imports", generateBundle(_, bundle) {
    for (const file of Object.values(bundle)) {
      if (file.type !== "chunk") continue
      if (file.imports.length || file.dynamicImports.length) throw new Error(`${name} has an external runtime import`)
      for (const id of Object.keys(file.modules)) {
        if (id.startsWith("\0")) continue
        const path = id.split("?")[0]
        if (!allowed.some((directory) => path === directory || path.startsWith(directory + sep))) throw new Error(`${name} imports private host code: ${relative(root, path)}`)
      }
    }
  } }
  await build({ configFile: false, root: source, publicDir: false, logLevel: "warn", define: { "process.env.NODE_ENV": JSON.stringify("production") }, plugins: [react(), tailwindcss(), boundary],
    build: { outDir: output, emptyOutDir: true, target: "es2022", minify: "esbuild", sourcemap: false, cssCodeSplit: false,
      lib: { entry: join(source, "runtime.tsx"), name: "CogpitPlugin", formats: ["iife"], fileName: () => manifest.entry, cssFileName: "plugin" },
      rollupOptions: { output: { inlineDynamicImports: true } },
    },
  })
  const assets = new Set(["plugin.json", "LICENSE", "NOTICE", ...manifest.contributes.panels.map((panel) => panel.icon), ...manifest.permissions.connections.map((connection) => connection.definition)])
  for (const path of assets) {
    validatePackagePath(path)
    await mkdir(dirname(join(output, path)), { recursive: true })
    await copyFile(join(source, path), join(output, path))
  }
  const files: { path: string; mime: string; content: string }[] = []
  async function collect(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) { await collect(path); continue }
      if (!entry.isFile()) throw new Error("Plugin output must contain only ordinary files")
      const name = relative(output, path).split(sep).join("/")
      const type = /^(LICENSE|NOTICE)$/u.test(name) ? "text/plain" : mime[extname(name)]
      if (!type) throw new Error(`Unsupported generated asset: ${name}`)
      files.push({ path: name, mime: type, content: (await readFile(path)).toString("base64") })
    }
  }
  await collect(output)
  files.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0)
  const payload = Buffer.from(JSON.stringify({ archiveVersion: 1, files }))
  const inspected = inspectPackage(payload, manifest.publisher)
  seeds.push({ id: manifest.id, publisher: manifest.publisher, targetPath: `${manifest.id}/${manifest.version}.json`, appVersion: app.version, payloadDigest: inspected.digest, payload: payload.toString("base64") })
  console.log(`Built ${manifest.id}@${manifest.version}: ${payload.length} bytes, SHA-256 ${inspected.digest}`)
}
if (requested.length) process.exit(0)
await mkdir(join(root, "generated/runtime-plugin-seeds"), { recursive: true })
await writeFile(join(root, "generated/runtime-plugin-seeds/index.json"), JSON.stringify(seeds))
