import { randomInt } from 'node:crypto';
import { ROOM_CODE_ALPHABET, ROOM_CODE_LENGTH } from '@cdr/shared';

/** Generates a 4-character code that is not currently in use. */
export function generateRoomCode(isTaken: (code: string) => boolean): string | null {
  for (let attempt = 0; attempt < 200; attempt++) {
    let code = '';
    for (let i = 0; i < ROOM_CODE_LENGTH; i++) {
      code += ROOM_CODE_ALPHABET[randomInt(ROOM_CODE_ALPHABET.length)];
    }
    if (!isTaken(code)) return code;
  }
  return null; // code space exhausted (practically never with MAX_ROOMS)
}
