import { projectOnStage, type BuiltStage, type PaceNote } from '@cdr/shared';

/**
 * Driver-side stage tracking: distance along the stage, remaining distance,
 * upcoming pace note and automatic call timing. Each note is announced
 * exactly once per run (no per-frame spam).
 */
export class RaceClient {
  distance: number;
  lateral = 0;
  /** On a fork's short cut / bypass (-1 = the main road). */
  branch = -1;
  private hint = -1;
  private announced = new Set<number>();
  nextNoteIndex = 0;
  onAnnounce: ((note: PaceNote, distanceTo: number) => void) | null = null;

  constructor(readonly stage: BuiltStage) {
    this.distance = stage.spawnDistance;
  }

  resetRun() {
    this.announced.clear();
    this.hint = -1;
    this.distance = this.stage.spawnDistance;
    this.nextNoteIndex = 0;
  }

  get remaining() {
    return Math.max(0, this.stage.finishDistance - this.distance);
  }

  get progress01() {
    const s = this.stage;
    return Math.min(1, Math.max(0, (this.distance - s.startDistance) / (s.finishDistance - s.startDistance)));
  }

  get nextNote(): PaceNote | null {
    return this.stage.paceNotes[this.nextNoteIndex] ?? null;
  }

  get distanceToNext() {
    const n = this.nextNote;
    return n ? n.distance - this.distance : -1;
  }

  /** Upcoming notes (for the navigator view). */
  upcoming(count: number) {
    return this.stage.paceNotes.slice(this.nextNoteIndex, this.nextNoteIndex + count);
  }

  update(x: number, z: number, speed: number, autoCalls: boolean) {
    const p = projectOnStage(this.stage, x, z, this.hint);
    this.hint = p.index;
    this.distance = p.distance;
    this.lateral = p.lateral;
    this.branch = p.branch;
    const notes = this.stage.paceNotes;
    let i = 0;
    while (i < notes.length && notes[i].distance < this.distance - 2) i++;
    this.nextNoteIndex = i;

    if (!autoCalls) return;
    // the notes are for the main road – none on a short cut
    if (this.branch >= 0) return;
    // Call far enough ahead to react: at least 70 m or ~3.5 s at current speed.
    const lead = Math.max(70, Math.abs(speed) * 3.5);
    for (let k = i; k < notes.length; k++) {
      const n = notes[k];
      const to = n.distance - this.distance;
      if (to > lead) break;
      if (!this.announced.has(n.index)) {
        this.announced.add(n.index);
        this.onAnnounce?.(n, to);
        break; // one call at a time
      }
    }
  }
}
