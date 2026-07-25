import { resolve } from 'node:path'
import { defineConfig } from 'vite'

export default defineConfig({
  // Relative asset URLs load reliably in multi-page Tauri webviews (esp. Windows WebView2).
  base: './',
  clearScreen: false,
  server: {
    host: '127.0.0.1',
    port: 1421,
    strictPort: true,
  },
  build: {
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
        menu: resolve(__dirname, 'menu.html'),
        settings: resolve(__dirname, 'settings.html'),
        panel: resolve(__dirname, 'panel.html'),
      },
    },
  },
})

