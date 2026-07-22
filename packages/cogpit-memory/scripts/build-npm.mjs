#!/usr/bin/env node
/**
 * Build cogpit-memory for npm distribution (Node.js compatible).
 *
 * - Bundles src/cli.ts → dist/cli.js  (CLI entry)
 * - Bundles src/index.ts → dist/index.js (library entry)
 * - Aliases "bun:sqlite" → sqlite-node-shim.ts (uses better-sqlite3)
 * - Keeps better-sqlite3 external (native module, can't be bundled)
 */
import { build } from "esbuild"
import { chmodSync, mkdirSync, rmSync } from "node:fs"

rmSync("dist", { recursive: true, force: true })
mkdirSync("dist", { recursive: true })

const shared = {
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node20",
  alias: { "bun:sqlite": "./src/lib/sqlite-node-shim.ts" },
  external: ["better-sqlite3"],
  sourcemap: false,
  // Strip bun-types references that won't resolve under Node
  define: { Bun: "undefined" },
}

await Promise.all([
  build({
    ...shared,
    entryPoints: ["src/cli.ts"],
    outfile: "dist/cli.js",
    banner: { js: "#!/usr/bin/env node" },
  }),
  build({
    ...shared,
    entryPoints: ["src/index.ts"],
    outfile: "dist/index.js",
  }),
])

chmodSync("dist/cli.js", 0o755)

console.log("Built dist/cli.js and dist/index.js")
