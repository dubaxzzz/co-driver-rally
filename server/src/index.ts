import express from 'express';
import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { Server } from 'socket.io';
import type { ClientToServerEvents, ServerToClientEvents } from '@cdr/shared';
import { config } from './config';
import { registerHandlers } from './networking/handlers';

const app = express();
const httpServer = createServer(app);

const allowAny = config.clientOrigins.includes('*');
const io = new Server<ClientToServerEvents, ServerToClientEvents>(httpServer, {
  cors: { origin: allowAny ? true : config.clientOrigins, credentials: true },
  maxHttpBufferSize: 16 * 1024, // protects against oversized messages
  pingInterval: 5000,
  pingTimeout: 8000,
});

const rooms = registerHandlers(io);

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, rooms: rooms.size, uptime: process.uptime() });
});

// In production the server also hosts the built client (npm run build).
const distDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../client/dist');
if (existsSync(distDir)) {
  app.use(express.static(distDir));
  app.get(/^(?!\/(api|socket\.io)).*/, (_req, res) => res.sendFile(path.join(distDir, 'index.html')));
}

httpServer.listen(config.port, config.host, () => {
  console.log(`[server] Co-Driver Rally listening on http://${config.host}:${config.port}`);
  if (existsSync(distDir)) console.log('[server] serving built client from client/dist');
});
