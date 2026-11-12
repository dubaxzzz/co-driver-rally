import express from 'express';
import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { Server } from 'socket.io';
import type { ClientToServerEvents, ServerToClientEvents } from '@cdr/shared';
import { config } from './config';
import { registerHandlers } from './networking/handlers';
import { dailyBoard, limitedEvents } from './daily/DailyBoard';
import { dailyChallenge, dailyKey, validateLimitedInput } from '@cdr/shared';

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

app.get('/api/daily', (_req, res) => {
  const date = dailyKey();
  res.json({ challenge: dailyChallenge(date), board: dailyBoard.top(date) });
});

// ---- limited-time events (everyone) + admin panel (needs the admin code) ----
app.use('/api/admin', express.json({ limit: '4kb' }));
app.get('/api/limited', (_req, res) => {
  res.json({ events: limitedEvents.list() });
});
const attempts = new Map<string, { n: number; since: number }>();
/** Checks the admin code, with a limit on wrong guesses per address. */
function isAdmin(req: express.Request): boolean | 'slow-down' {
  const ip = req.ip ?? 'unknown';
  const now = Date.now();
  const a = attempts.get(ip) ?? { n: 0, since: now };
  if (now - a.since > 60_000) Object.assign(a, { n: 0, since: now });
  if (a.n >= 8) return 'slow-down';
  const code = typeof req.body?.code === 'string' ? req.body.code.trim() : '';
  const ok = code.length > 0 && code.toUpperCase() === config.adminCode.toUpperCase();
  if (!ok) {
    a.n++;
    attempts.set(ip, a);
  }
  return ok;
}
const deny = (res: express.Response, r: boolean | 'slow-down') =>
  res.status(r === 'slow-down' ? 429 : 403).json({ ok: false, message: r === 'slow-down' ? 'Too many wrong codes – wait a minute.' : 'Wrong admin code.' });
app.post('/api/admin/login', (req, res) => {
  const r = isAdmin(req);
  if (r !== true) return deny(res, r);
  res.json({ ok: true });
});
app.post('/api/admin/events', (req, res) => {
  const r = isAdmin(req);
  if (r !== true) return deny(res, r);
  const input = validateLimitedInput(req.body?.event);
  if (!input) return res.status(400).json({ ok: false, message: 'Check the event details.' });
  const ev = limitedEvents.create(input);
  io.emit('limited:changed');
  res.json({ ok: true, event: ev });
});
app.post('/api/admin/events/delete', (req, res) => {
  const r = isAdmin(req);
  if (r !== true) return deny(res, r);
  const ok = typeof req.body?.id === 'string' && limitedEvents.remove(req.body.id);
  io.emit('limited:changed');
  res.json({ ok });
});

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
