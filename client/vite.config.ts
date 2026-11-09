import { defineConfig, loadEnv } from 'vite';
import { fileURLToPath } from 'node:url';

const rootDir = fileURLToPath(new URL('..', import.meta.url));

export default defineConfig(({ mode }) => {
  // Load the shared .env from the repository root.
  const env = loadEnv(mode, rootDir, '');
  const target = env.VITE_DEV_SERVER_TARGET || 'http://localhost:3001';
  return {
    envDir: rootDir,
    base: '/',
    server: {
      host: true, // expose on LAN so a tablet can join
      port: Number(env.VITE_PORT || 5173),
      proxy: {
        '/socket.io': { target, ws: true, changeOrigin: true },
        '/api': { target, changeOrigin: true },
      },
    },
    preview: { host: true },
    build: {
      target: 'es2022',
      outDir: 'dist',
      emptyOutDir: true,
      chunkSizeWarningLimit: 2500,
    },
    optimizeDeps: {
      exclude: ['@dimforge/rapier3d-compat'],
    },
  };
});
