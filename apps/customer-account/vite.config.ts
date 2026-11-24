import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// I utveckling proxas API-anrop till backend så att cookies är same-origin.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5174,
    proxy: { '/api/v1': { target: 'http://127.0.0.1:4000', changeOrigin: false } },
  },
  build: { sourcemap: false },
});
