/** Dependency-free runtime validation of untrusted socket payloads. */
import {
  CUSTOM_MESSAGE_MAX_LENGTH,
  PLAYER_NAME_MAX_LENGTH,
  ROOM_CODE_REGEX,
} from './constants';
import type { NavCallRequest, TelemetryPacket } from './types';

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isNum = (v: unknown, min = -1e7, max = 1e7): v is number =>
  typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max;

export function normaliseRoomCode(code: unknown): string | null {
  if (typeof code !== 'string') return null;
  const c = code.trim().toUpperCase();
  return ROOM_CODE_REGEX.test(c) ? c : null;
}

export function sanitiseText(text: unknown, maxLen: number): string | null {
  if (typeof text !== 'string') return null;
  // strip control characters & angle brackets, collapse whitespace
  const clean = text.replace(/[\u0000-\u001f\u007f<>]/g, '').replace(/\s+/g, ' ').trim();
  if (!clean) return null;
  return clean.slice(0, maxLen);
}

export function sanitiseName(name: unknown, fallback: string): string {
  return sanitiseText(name, PLAYER_NAME_MAX_LENGTH) ?? fallback;
}

const TELEMETRY_NUMERIC: Array<[keyof TelemetryPacket, number, number]> = [
  ['runId', 0, 1e9],
  ['seq', 0, 1e12],
  ['t', -1e3, 1e8],
  ['x', -1e5, 1e5],
  ['y', -1e4, 1e4],
  ['z', -1e5, 1e5],
  ['h', -100, 100],
  ['p', -10, 10],
  ['r', -10, 10],
  ['v', -200, 200],
  ['steer', -1.01, 1.01],
  ['throttle', 0, 1.01],
  ['brake', 0, 1.01],
  ['gear', -1, 10],
  ['rpm', 0, 20000],
  ['dist', -10, 1e6],
  ['remain', -10, 1e6],
  ['cp', 0, 100],
  ['nextNote', -1, 10000],
  ['toNote', -1e5, 1e6],
  ['dmg', 0, 1],
  ['resets', 0, 1e6],
];

export function validateTelemetry(p: unknown): TelemetryPacket | null {
  if (!isObj(p)) return null;
  const out: Record<string, unknown> = {};
  for (const [key, min, max] of TELEMETRY_NUMERIC) {
    const v = p[key];
    if (!isNum(v, min, max)) return null;
    out[key] = v;
  }
  if (typeof p.handbrake !== 'boolean') return null;
  out.handbrake = p.handbrake;
  return out as unknown as TelemetryPacket;
}

export function validateNavCall(p: unknown): NavCallRequest | null {
  if (!isObj(p)) return null;
  const kind = p.kind;
  if (kind !== 'pacenote' && kind !== 'caution' && kind !== 'repeat' && kind !== 'custom') return null;
  const req: NavCallRequest = { kind };
  if (kind !== 'repeat') {
    const text = sanitiseText(p.text, CUSTOM_MESSAGE_MAX_LENGTH);
    if (!text) return null;
    req.text = text.toUpperCase();
  }
  if (p.noteIndex !== undefined && p.noteIndex !== null) {
    if (!isNum(p.noteIndex, 0, 10000) || !Number.isInteger(p.noteIndex)) return null;
    req.noteIndex = p.noteIndex;
  }
  return req;
}
