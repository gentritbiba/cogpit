import { defineConfig, externalizeDepsPlugin } from "electron-vite"
import react from "@vitejs/plugin-react"
import tailwindcss from "@tailwindcss/vite"
import { fileURLToPath, URL } from "node:url"
import { manualChunks } from "./build/manualChunks"

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      outDir: "out/main",
      lib: {
        entry: {
          main: "electron/main.ts",
          "server-worker": "electron/server-worker.ts",
        },
      },
      rollupOptions: {
        external: ["node-pty"],
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      outDir: "out/preload",
      lib: {
        entry: "electron/preload.ts",
        // The BrowserWindow uses sandbox: true, which only supports CJS
        // preload scripts. The package is ESM, so without this the build
        // emits preload.mjs — which the sandboxed renderer cannot load.
        formats: ["cjs"],
      },
    },
  },
  renderer: {
    root: ".",
    build: {
      outDir: "out/renderer",
      sourcemap: false,
      rollupOptions: {
        input: "index.html",
        output: { manualChunks },
      },
    },
    plugins: [
      react({
        babel: {
          plugins: [["babel-plugin-react-compiler"]],
        },
      }),
      tailwindcss(),
      {
        // electron-vite forces "./" for production renderers, but Cogpit always
        // serves this renderer over HTTP. Override the preset after it runs so
        // assets still load when /:project/:session is refreshed directly.
        name: "cogpit:root-renderer-base",
        enforce: "post",
        config: () => ({ base: "/" }),
      },
    ],
    resolve: {
      alias: {
        "@": fileURLToPath(new URL("./src", import.meta.url)),
      },
    },
  },
})
