import { defineConfig } from 'vite';

export default defineConfig({
  // OneDrive marks package files as reparse points. Skipping Vite's optional
  // dependency pre-bundle avoids an esbuild traversal outside the workspace;
  // production builds are unaffected.
  optimizeDeps: {
    noDiscovery: true,
    include: [],
  },
});
