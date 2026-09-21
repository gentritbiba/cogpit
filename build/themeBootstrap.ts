import { fileURLToPath } from "node:url"
import { build } from "esbuild"
import type { Plugin } from "vite"

const filename = "theme-bootstrap.js"

export function themeBootstrap(): Plugin {
  const compile = async () => {
    const result = await build({
      entryPoints: [fileURLToPath(new URL("../src/theme-bootstrap.ts", import.meta.url))],
      bundle: true, format: "iife", minify: true, write: false,
    })
    return result.outputFiles[0].text
  }
  return {
    name: "cogpit:theme-bootstrap",
    configureServer(server) {
      server.middlewares.use(`/${filename}`, (_request, response, next) => {
        void compile().then(code => {
          response.setHeader("Content-Type", "text/javascript")
          response.setHeader("Cache-Control", "no-store")
          response.end(code)
        }).catch(next)
      })
    },
    async generateBundle() {
      this.emitFile({ type: "asset", fileName: filename, source: await compile() })
    },
    transformIndexHtml: {
      order: "post",
      handler: () => [{ tag: "script", attrs: { src: `/${filename}` }, injectTo: "head" }],
    },
  }
}
