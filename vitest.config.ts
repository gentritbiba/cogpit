import { join } from "node:path"
import { defineConfig } from "vitest/config"
import { fileURLToPath, URL } from "node:url"
import { editionAliases } from "./build/editionAliases"
import { hasTeamEdition, root, TEAM_EDITION_ENTRY } from "./scripts/lib/sourceFiles"

// The team edition is a private package; a public clone's editions/team is empty.
// COGPIT_WITHOUT_TEAM=1 (`bun run test:public`) runs the suite as that checkout.
const withTeam = hasTeamEdition && process.env.COGPIT_WITHOUT_TEAM !== "1"

export default defineConfig({
  resolve: {
    alias: [
      { find: "@", replacement: fileURLToPath(new URL("./src", import.meta.url)) },
      ...editionAliases(),
      ...(withTeam ? [{ find: "@cogpit/team", replacement: join(root, TEAM_EDITION_ENTRY) }] : []),
    ],
  },
  test: {
    css: { include: [/theme\.css\?raw$/] },
    globals: true,
    environment: "jsdom",
    setupFiles: ["./src/__tests__/setup.ts"],
    include: [
      "src/**/*.test.ts",
      "src/**/*.test.tsx",
      "plugins/**/*.test.ts",
      "plugins/**/*.test.tsx",
      "server/**/*.test.ts",
      "electron/**/*.test.ts",
      "packages/plugin-contracts/**/*.test.ts",
      "packages/plugin-sdk/**/*.test.ts",
      "packages/plugin-tools/**/*.test.ts",
      ...(withTeam ? ["editions/team/tests/**/*.test.{ts,tsx}"] : []),
    ],
    coverage: {
      provider: "v8",
      // Ratchet the portable business/security core. Renderer components and
      // hooks use behavior-focused Testing Library suites plus React Doctor;
      // Electron is covered by strict types, integration tests, and its build.
      include: [
        "shared/**/*.{ts,tsx}",
        "src/lib/**/*.{ts,tsx}",
        "server/**/*.{ts,tsx}",
        ...(withTeam ? ["editions/team/server/**/*.ts"] : []),
      ],
      exclude: ["**/__tests__/**", "**/*.test.*", "**/setup.ts", "**/fixtures/**"],
      thresholds: {
        statements: 67.5,
        branches: 63,
        functions: 68,
        lines: 69.5,
      },
    },
  },
})
