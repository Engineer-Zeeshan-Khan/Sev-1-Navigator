
import { defineConfig } from 'electron-vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  main: {
    build: {
      outDir: 'out/main',
      rollupOptions: {
        input: 'src/main/index.ts',
        // Native addons are loaded by Electron at runtime and cannot be bundled as browser code.
        external: ['better-sqlite3']
      }
    }
  },
  preload: {
    build: {
      outDir: 'out/preload',
      rollupOptions: {
        input: 'src/preload/index.ts'
      }
    }
  },
  renderer: {
    plugins: [react()],
    build: {
      outDir: 'out/renderer'
    }
  }
});
