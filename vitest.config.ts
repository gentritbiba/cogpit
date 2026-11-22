import { join } from "node:path"
import { defineConfig } from "vitest/config"
import { fileURLToPath, URL } from "node:url"
import { DurationSequencer } from "./build/durationSequencer"
import { editionAliases } from "./build/editionAliases"
import { viewLibraryAliases } from "./build/viewLibraryAliases"
import { hasTeamEdition, root, TEAM_EDITION_ENTRY } from "./scripts/lib/sourceFiles"

// The team edition is a private package; a public clone's editions/team is empty.
// COGPIT_WITHOUT_TEAM=1 (`bun run test:public`) runs the suite as that checkout.
const withTeam = hasTeamEdition && process.env.COGPIT_WITHOUT_TEAM !== "1"

export default defineConfig({
  resolve: {
    alias: [
      { find: "@", replacement: fileURLToPath(new URL("./src", import.meta.url)) },
      ...editionAliases(),
      ...viewLibraryAliases(),
      ...(withTeam ? [{ find: "@cogpit/team", replacement: join(root, TEAM_EDITION_ENTRY) }] : []),
    ],
  },
  test: {
    // Hosted Windows runners are several times slower than the other platforms.
    ...(process.platform === "win32" ? { testTimeout: 20_000, hookTimeout: 30_000 } : {}),
    // A test that only fails under a loaded CI runner would otherwise block a
    // release until someone reruns it; CI's github-actions reporter lists the
    // tests that passed only on a retry in the job summary.
    retry: process.env.CI ? 2 : 0,
    sequence: { sequencer: DurationSequencer },
    css: { include: [/theme\.css\?raw$/] },
    globals: true,
    setupFiles: ["./src/__tests__/setup.ts"],
    // Only the UI suites need a jsdom window; the server's run in Node's environment.
    projects: [
      {
        extends: true,
        test: {
          name: "dom",
          environment: "jsdom",
          // Workers start faster than processes. The node project keeps
          // processes: its suites change process-wide state threads share.
          pool: "threads",
          include: [
            "src/**/*.test.ts",
            "src/**/*.test.tsx",
            "plugins/**/*.test.ts",
            "plugins/**/*.test.tsx",
            ...(withTeam ? ["editions/team/tests/ui/**/*.test.{ts,tsx}"] : []),
          ],
        },
      },
      {
        extends: true,
        test: {
          name: "node",
          environment: "node",
          include: [
            "server/**/*.test.ts",
            "electron/**/*.test.ts",
            "packages/plugin-contracts/**/*.test.ts",
            "packages/plugin-sdk/**/*.test.ts",
            "packages/plugin-tools/**/*.test.ts",
            "packages/telemetry-ingest/**/*.test.ts",
            ...(withTeam ? ["editions/team/tests/**/*.test.{ts,tsx}"] : []),
          ],
          exclude: ["**/node_modules/**", ...(withTeam ? ["editions/team/tests/ui/**"] : [])],
        },
      },
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
