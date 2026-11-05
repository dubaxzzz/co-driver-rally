import { defineConfig, loadEnv } from 'vite';
import { fileURLToPath } from 'node:url';

const rootDir = fileURLToPath(new URL('..', import.meta.url));

export default defineConfig(({ mode }) => {
  // Load the shared .env from the repository root.
  const env = loadEnv(mode, rootDir, '');
  const target = env.VITE_DEV_SERVER_TARGET || 'http://localhost:3001';
  // `--mode play` builds the serverless (peer-to-peer) version into /play,
  // ready to open with VS Code's Live Server or upload to any static host.
  const play = mode === 'play';
  return {
    envDir: rootDir,
    base: play ? './' : '/',
    define: play ? { 'import.meta.env.VITE_TRANSPORT': JSON.stringify('p2p') } : {},
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
      outDir: play ? fileURLToPath(new URL('../play', import.meta.url)) : 'dist',
      emptyOutDir: true,
      chunkSizeWarningLimit: 2500,
    },
    optimizeDeps: {
      exclude: ['@dimforge/rapier3d-compat'],
    },
  };
});
