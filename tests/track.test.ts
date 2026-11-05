/** Validates the generated stage: no self-intersections, sane notes and checkpoints. */
import { getStage, DEFAULT_STAGE_ID, projectOnStage } from '../shared/src/index';

const stage = getStage(DEFAULT_STAGE_ID)!;
let failures = 0;
const check = (ok: boolean, msg: string) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${msg}`);
  if (!ok) failures++;
};

console.log(`Stage ${stage.def.name}: ${stage.length.toFixed(0)} m, ${stage.paceNotes.length} notes`);
console.log(`Bounds x ${stage.bounds.minX.toFixed(0)}..${stage.bounds.maxX.toFixed(0)}  z ${stage.bounds.minZ.toFixed(0)}..${stage.bounds.maxZ.toFixed(0)}`);

// Minimum distance between road sections that are far apart along the route
let minGap = Infinity;
const s = stage.samples;
for (let i = 0; i < s.length; i += 2) {
  for (let j = i + 120; j < s.length; j += 2) {
    const d = Math.hypot(s[i].x - s[j].x, s[i].z - s[j].z);
    if (d < minGap) minGap = d;
  }
}
check(minGap > stage.def.roadWidth + 6, `road never overlaps itself (closest separate section ${minGap.toFixed(1)} m)`);
check(stage.checkpoints.length === 3, 'three checkpoints');
check(stage.checkpoints.every((c, i, a) => i === 0 || c.distance > a[i - 1].distance), 'checkpoints are ordered');
check(stage.paceNotes.every((n, i, a) => i === 0 || n.distance >= a[i - 1].distance), 'pace notes sorted by distance');

let maxErr = 0;
let hint = -1;
for (let d = 0; d < stage.length; d += 3) {
  const p = s[Math.round(d)];
  const r = projectOnStage(stage, p.x + Math.cos(p.h) * 2, p.z - Math.sin(p.h) * 2, hint);
  hint = r.index;
  maxErr = Math.max(maxErr, Math.abs(r.distance - d));
}
check(maxErr < 3, `progress projection is continuous (max error ${maxErr.toFixed(2)} m)`);

if (failures) process.exit(1);
