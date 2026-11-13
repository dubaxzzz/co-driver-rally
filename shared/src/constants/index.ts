/** Network + gameplay constants shared by client and server. */

/** Room codes avoid ambiguous characters (0/O, 1/I/L). */
export const ROOM_CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const ROOM_CODE_LENGTH = 4;
export const ROOM_CODE_REGEX = /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{4}$/;

/** Driver sends telemetry at ~20 Hz. */
export const TELEMETRY_HZ = 20;
export const TELEMETRY_INTERVAL_MS = 1000 / TELEMETRY_HZ;
/** Server drops telemetry arriving faster than this (per socket, per second). */
export const TELEMETRY_MAX_PER_SECOND = 40;
/** Navigator renders this far in the past so it can interpolate between packets. */
export const INTERPOLATION_DELAY_MS = 120;

/** Pre-stage: time to do the cockpit checks (ignition, start, lights) before GO. */
/** The 3-2-1 countdown, once every driver has started their engine. */
export const COUNTDOWN_MS = 5000;
/** How long the start waits for engines before counting down anyway. */
export const ENGINE_WAIT_MS = 120000;
/** Up to four people per lobby: any mix of drivers and navigators. */
export const MAX_MEMBERS = 4;
export const MAX_DRIVERS = 4;
/** Spectators on top of the 4 players. */
export const MAX_SPECTATORS = 8;
/** Grid: two cars side by side, rows this far apart (metres). */
export const GRID_ROW_GAP_M = 10;
export const GRID_SIDE_OFFSET_M = 2.1;
export const NAV_CALL_MAX_PER_SECOND = 4;
export const CUSTOM_MESSAGE_MAX_LENGTH = 40;
export const PLAYER_NAME_MAX_LENGTH = 16;
export const CALL_LOG_LENGTH = 20;

/** Physical sanity limits used by the server when validating telemetry. */
export const MAX_PLAUSIBLE_SPEED_MS = 75; // ~270 km/h
export const MAX_TELEPORT_SLACK_M = 25;

/** Default timings (server may override from environment). */
export const DEFAULT_ROOM_ABANDON_MS = 120_000;
export const DEFAULT_NAVIGATOR_RECONNECT_GRACE_MS = 60_000;
export const DEFAULT_ROOM_IDLE_MAX_MS = 3 * 60 * 60 * 1000;

export const SESSION_STORAGE_KEY = 'cdr.session';
