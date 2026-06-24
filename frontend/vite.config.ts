import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

// Vite config for hyni.web.
//
// - Dev:   `npm run dev` serves on 5173 and proxies /api -> Drogon on 8848.
//          Also forwards COOP/COEP headers so the wstream WASM adapter works
//          in development too.
// - Build: `npm run build` outputs to ../public/app, which the Drogon backend
//          serves as static. Run the backend with no separate dev server in
//          production.
export default defineConfig({
  plugins: [react()],
  base: '/app/',
  server: {
    port: 5173,
    strictPort: true,
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'credentialless',
      'Cross-Origin-Resource-Policy': 'cross-origin',
    },
    proxy: {
      '/api': {
        target: 'http://localhost:8848',
        changeOrigin: false,
      },
      '/wstream': {
        target: 'http://localhost:8848',
        changeOrigin: false,
      },
    },
  },
  build: {
    outDir: resolve(__dirname, '../public/app'),
    emptyOutDir: true,
    sourcemap: false,
  },
});
