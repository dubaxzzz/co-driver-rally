import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  DEFAULT_NAVIGATOR_RECONNECT_GRACE_MS,
  DEFAULT_ROOM_ABANDON_MS,
  DEFAULT_ROOM_IDLE_MAX_MS,
} from '@cdr/shared';

// Minimal .env loader (repository root) – real environment variables win.
const envPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../.env');
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/i);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
  }
}

const num = (v: string | undefined, fallback: number) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

export const config = {
  port: num(process.env.PORT, 3001),
  host: process.env.HOST || '0.0.0.0',
  production: process.env.NODE_ENV === 'production',
  clientOrigins: (process.env.CLIENT_ORIGIN || 'http://localhost:5173')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
  roomAbandonMs: num(process.env.ROOM_ABANDON_MS, DEFAULT_ROOM_ABANDON_MS),
  navigatorGraceMs: num(process.env.NAVIGATOR_RECONNECT_GRACE_MS, DEFAULT_NAVIGATOR_RECONNECT_GRACE_MS),
  roomIdleMaxMs: num(process.env.ROOM_IDLE_MAX_MS, DEFAULT_ROOM_IDLE_MAX_MS),
  maxRooms: num(process.env.MAX_ROOMS, 500),
  cleanupIntervalMs: 10_000,
};
