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

const shared = {
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node18",
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

console.log("Built dist/cli.js and dist/index.js")
