/** Dependency-free runtime validation of untrusted socket payloads. */
import {
  CUSTOM_MESSAGE_MAX_LENGTH,
  PLAYER_NAME_MAX_LENGTH,
  ROOM_CODE_REGEX,
} from './constants';
import { getStage } from './tracks';
import type { AiSkill, NavCallRequest, RallyConfig, TelemetryPacket } from './types';
import { WEATHER_IDS, type WeatherId } from './weather';

const AI_SKILLS: AiSkill[] = ['easy', 'medium', 'hard'];
export const MAX_AI = 3;

/** Validates a (partial) lobby configuration. Returns null if anything is invalid. */
export function validateConfig(p: unknown): Partial<RallyConfig> | null {
  if (!isObj(p)) return null;
  const out: Partial<RallyConfig> = {};
  if (p.stageId !== undefined) {
    if (typeof p.stageId !== 'string' || !getStage(p.stageId)) return null;
    out.stageId = p.stageId;
  }
  if (p.weather !== undefined) {
    if (!WEATHER_IDS.includes(p.weather as WeatherId)) return null;
    out.weather = p.weather as WeatherId;
  }
  if (p.aiCount !== undefined) {
    if (!isNum(p.aiCount, 0, MAX_AI) || !Number.isInteger(p.aiCount)) return null;
    out.aiCount = p.aiCount;
  }
  if (p.aiSkill !== undefined) {
    if (!AI_SKILLS.includes(p.aiSkill as AiSkill)) return null;
    out.aiSkill = p.aiSkill as AiSkill;
  }
  return out;
}

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
  if (p.ai !== undefined) {
    const ai = p.ai;
    if (!Array.isArray(ai) || ai.length > MAX_AI * 6 || ai.length % 6 !== 0) return null;
    if (!ai.every((n) => isNum(n, -1e6, 1e8))) return null;
    out.ai = ai;
  }
  if (p.dz !== undefined) {
    const dz = p.dz;
    if (!Array.isArray(dz) || (dz.length !== 6 && dz.length !== 10) || !dz.every((n) => isNum(n, 0, 1))) return null;
    out.dz = dz;
  }
  if (p.prize !== undefined) {
    if (!isNum(p.prize, 0, 1e7)) return null;
    out.prize = p.prize;
  }
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
