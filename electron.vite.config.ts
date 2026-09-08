import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'

const shared = { '@shared': resolve('src/shared') }

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    resolve: { alias: shared },
    build: { rollupOptions: { input: resolve('src/main/index.ts') } }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    resolve: { alias: shared },
    build: { rollupOptions: { input: resolve('src/preload/index.ts') } }
  },
  renderer: {
    root: resolve('src/renderer'),
    resolve: { alias: shared },
    build: { rollupOptions: { input: resolve('src/renderer/index.html') } }
  }
})
