import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: { port: 5173, strictPort: true },          // backend CORS allow-list expects :5173
  preview: { allowedHosts: true },
  test: { environment: 'jsdom', globals: false },
});
