import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Web app is a thin client over the Cloudflare Worker (the shared analysis brain).
// Deployed to Cloudflare Pages; talks to marketscope-proxy.ludikure.workers.dev directly.
export default defineConfig({
  plugins: [react()],
  server: { port: 5173 },
});
