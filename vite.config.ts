import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Served from GitHub Pages as a project page (https://<user>.github.io/meq/),
// so assets must be requested with the /meq/ prefix in production. Local dev
// and `vite preview` still work fine at the root since Vite resolves `base`
// relative to how the dev server is addressed.
export default defineConfig({
  base: process.env.GITHUB_PAGES ? '/meq/' : '/',
  plugins: [react()],
  server: { port: 5173 },
});
