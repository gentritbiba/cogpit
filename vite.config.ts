import { fileURLToPath, URL } from 'node:url'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { sessionApiPlugin } from './server/api-plugin'
import { ptyPlugin } from './server/pty-plugin'
import { bundleBoundary } from './build/bundleBoundary'
import { editionAliases } from './build/editionAliases'
import { chunkFileNames, editionUiBanner, manualChunks } from './build/manualChunks'
import { themeBootstrap } from './build/themeBootstrap'

export default defineConfig({
  plugins: [
    themeBootstrap(),
    react({
      babel: {
        plugins: [['babel-plugin-react-compiler']],
      },
    }),
    tailwindcss(),
    sessionApiPlugin(),
    ptyPlugin(),
    bundleBoundary(),
    editionUiBanner(),
  ],
  resolve: {
    alias: [
      { find: '@', replacement: fileURLToPath(new URL('./src', import.meta.url)) },
      ...editionAliases(),
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
      ignored: ['**/undo-history/**', '**/.claude/worktrees/**'],
    },
  },
})
