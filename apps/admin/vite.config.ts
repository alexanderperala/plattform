import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Superadmin körs på egen värd i produktion. I utveckling proxas API-anrop till backend så att cookies är same-origin.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: { '/api/platform-admin': { target: 'http://127.0.0.1:4000', changeOrigin: false } },
  },
  build: { sourcemap: false },
});
