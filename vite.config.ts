import { fileURLToPath, URL } from 'node:url'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { sessionApiPlugin } from './server/api-plugin'
import { ptyPlugin } from './server/pty-plugin'
import { manualChunks } from './build/manualChunks'

export default defineConfig({
  plugins: [
    react({
      babel: {
        plugins: [['babel-plugin-react-compiler']],
      },
    }),
    tailwindcss(),
    sessionApiPlugin(),
    ptyPlugin(),
  ],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  build: {
    chunkSizeWarningLimit: 800,
    rollupOptions: {
      output: { manualChunks },
    },
  },
  server: {
    watch: {
      ignored: ['**/undo-history/**', '**/.claude/worktrees/**'],
    },
  },
})
