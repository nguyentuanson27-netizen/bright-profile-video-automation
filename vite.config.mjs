import {defineConfig} from 'vite';

export default defineConfig({
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
  server: {
    host: '127.0.0.1',
    strictPort: true,
    port: 5173,
    proxy: {
      '/api': 'http://127.0.0.1:4180',
      '/health': 'http://127.0.0.1:4180',
    },
  },
});
