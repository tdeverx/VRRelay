import { defineConfig } from 'vite';
import { sveltekit } from '@sveltejs/kit/vite';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [tailwindcss(), sveltekit()],
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': { target: 'http://127.0.0.1:8099', ws: true },
      '/play': { target: 'http://127.0.0.1:8099' },
      '/internal': { target: 'http://127.0.0.1:8099' }
    }
  }
});
