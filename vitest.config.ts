import { defineConfig } from "vitest/config"
import { fileURLToPath, URL } from "node:url"

export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  test: {
    globals: true,
    environment: "jsdom",
    setupFiles: ["./src/__tests__/setup.ts"],
    include: [
      "src/**/*.test.ts",
      "src/**/*.test.tsx",
      "server/**/*.test.ts",
    ],
    coverage: {
      provider: "v8",
      // Ratchet the portable business/security core. Renderer components and
      // hooks use behavior-focused Testing Library suites plus React Doctor;
      // Electron is covered by strict types, integration tests, and its build.
      include: ["shared/**/*.{ts,tsx}", "src/lib/**/*.{ts,tsx}", "server/**/*.{ts,tsx}"],
      exclude: ["**/__tests__/**", "**/*.test.*", "**/setup.ts", "**/fixtures/**"],
      thresholds: {
        statements: 67.5,
        branches: 63,
        functions: 68,
        lines: 69.5,
      },
    },
    // Server tests use node environment via inline config
    environmentMatchGlobs: [
      ["server/**/*.test.ts", "node"],
    ],
  },
})
