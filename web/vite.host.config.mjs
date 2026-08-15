import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const projectRoot = dirname(fileURLToPath(new URL('.', import.meta.url)));

// Bundles the landing page's MCP Apps demo host (web/widgets-demo/host.mjs
// plus the ext-apps AppBridge and fixtures.json) into a single classic
// script. web/build.mjs copies the output into dist-site/widgets/.
export default defineConfig({
  build: {
    outDir: resolve(projectRoot, 'dist/site-widgets'),
    emptyOutDir: true,
    lib: {
      entry: resolve(projectRoot, 'web/widgets-demo/host.mjs'),
      formats: ['es'],
      fileName: () => 'host.js',
    },
  },
});
