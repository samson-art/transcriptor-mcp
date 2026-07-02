import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { viteSingleFile } from 'vite-plugin-singlefile';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { existsSync, renameSync } from 'node:fs';

const projectRoot = dirname(fileURLToPath(import.meta.url));

// Which app to build is selected via the APP env var: `APP=search vite build`.
// Valid values: "search" | "transcript" | "video-info" | "video-frame". Defaults to "search".
const app = process.env.APP ?? 'search';

// All apps emit into a shared dist/ui directory as single self-contained HTML
// files (dist/ui/search.html, dist/ui/transcript.html). emptyOutDir is disabled
// so building one app never wipes the other app's previously built output.
const outDir = resolve(projectRoot, 'dist/ui');

export default defineConfig({
  root: resolve(projectRoot, 'ui', app),
  resolve: {
    alias: { '@shared': resolve(projectRoot, 'ui/shared') },
  },
  plugins: [
    react(),
    viteSingleFile(),
    {
      // vite-plugin-singlefile inlines JS+CSS into the entry index.html; rename
      // that single file to <app>.html so each app lands at dist/ui/<app>.html.
      name: 'transcriptor-rename-single-file',
      closeBundle() {
        const from = resolve(outDir, 'index.html');
        const to = resolve(outDir, `${app}.html`);
        if (existsSync(from)) {
          renameSync(from, to);
        }
      },
    },
  ],
  build: {
    outDir,
    emptyOutDir: false,
    rollupOptions: {
      input: 'index.html',
    },
  },
});
