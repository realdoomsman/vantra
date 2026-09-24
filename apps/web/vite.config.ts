import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const API = 'http://localhost:8787';

export default defineConfig({
  plugins: [react()],
  build: {
    rollupOptions: {
      output: {
        manualChunks: {
          react: ['react', 'react-dom', 'react-router-dom', 'zustand'],
          // viem is the whole chain layer now: the wallet connection, the ERC-20 encoding and the
          // receipt polling. Split out so a visitor who never opens a wallet does not pay for it.
          chain: ['viem'],
        },
      },
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/api': { target: API, changeOrigin: true },
      '/ws': { target: API, ws: true, changeOrigin: true },
      '/sites': { target: API, changeOrigin: true },
      '/svc': { target: API, changeOrigin: true },
      '/rpc': { target: API, changeOrigin: true },
    },
  },
});
