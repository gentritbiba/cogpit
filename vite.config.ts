import { fileURLToPath, URL } from 'node:url'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { sessionApiPlugin } from './server/api-plugin'
import { ptyPlugin } from './server/pty-plugin'
import { bundleBoundary } from './build/bundleBoundary'
import { editionAliases } from './build/editionAliases'
import { VIEW_LIBRARY_IDS, viewLibraryAliases } from './build/viewLibraryAliases'
import { chunkFileNames, editionUiBanner, manualChunks } from './build/manualChunks'
import { themeBootstrap } from './build/themeBootstrap'

// `--mode renderer` serves only the renderer, for the desktop shell's server to proxy (`bun run desktop:dev`).
export default defineConfig(({ mode }) => ({
  worker: { format: "es" },
  optimizeDeps: { exclude: VIEW_LIBRARY_IDS },
  plugins: [
    themeBootstrap(),
    react({
      babel: {
        plugins: [['babel-plugin-react-compiler']],
      },
    }),
    tailwindcss(),
    ...(mode === "renderer" ? [] : [sessionApiPlugin(), ptyPlugin()]),
    bundleBoundary(),
    editionUiBanner(),
  ],
  resolve: {
    alias: [
      { find: '@', replacement: fileURLToPath(new URL('./src', import.meta.url)) },
      ...editionAliases(),
      ...viewLibraryAliases(),
    ],
  },
  build: {
    chunkSizeWarningLimit: 800,
    rollupOptions: {
      output: { manualChunks, chunkFileNames },
    },
  },
  server: {
    watch: {
      ignored: ['**/undo-history/**', '**/session-config/**', '**/.claude/worktrees/**', '**/target/**', '**/desktop/resources/**'],
    },
  },
}))
