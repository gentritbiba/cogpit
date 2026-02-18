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
      include: ["src/lib/**", "server/**"],
      exclude: ["**/*.test.*", "**/setup.ts", "**/fixtures/**"],
    },
    // Server tests use node environment via inline config
    environmentMatchGlobs: [
      ["server/**/*.test.ts", "node"],
    ],
  },
})
