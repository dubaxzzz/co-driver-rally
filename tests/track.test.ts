/** Validates every stage: no self-intersections, ordered notes/checkpoints, sane bridges. */
import { STAGE_DEFS, getStage, projectOnStage, surfaceAt } from '../shared/src/index';

let failures = 0;
const check = (ok: boolean, msg: string) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${msg}`);
  if (!ok) failures++;
};

for (const def of STAGE_DEFS) {
  const stage = getStage(def.id)!;
  const s = stage.samples;
  console.log(`\n${def.name} (${def.id}): ${((stage.finishDistance - stage.startDistance) / 1000).toFixed(2)} km, ${stage.bridges.length} bridge(s), surfaces: ${[...new Set(stage.surfaceSpans.map((x) => x.surface))].join(', ')}`);

  let minGap = Infinity;
  for (let i = 0; i < s.length; i += 2) {
    for (let j = i + 120; j < s.length; j += 2) {
      const d = Math.hypot(s[i].x - s[j].x, s[i].z - s[j].z);
      if (d < minGap) minGap = d;
    }
  }
  check(minGap > def.roadWidth + 6, `road never overlaps itself (closest separate section ${minGap.toFixed(1)} m)`);
  check(stage.checkpoints.every((c, i, a) => i === 0 || c.distance > a[i - 1].distance), 'checkpoints are ordered');

  for (const b of stage.bridges) {
    // no other part of the road within 45 m of the bridge (the river needs room)
    let near = Infinity;
    for (const p of s) if (Math.abs(p.d - b.distance) > 90) near = Math.min(near, Math.hypot(p.x - b.x, p.z - b.z));
    check(near > 45, `bridge ${b.index + 1} has room for its river (nearest other road ${near.toFixed(0)} m)`);
    check(surfaceAt(stage, b.distance) === 'wood', `bridge ${b.index + 1} deck is a wooden surface`);
  }

  let maxErr = 0;
  let hint = -1;
  for (let d = 0; d < stage.length; d += 3) {
    const p = s[Math.round(d)];
    const r = projectOnStage(stage, p.x + Math.cos(p.h) * 2, p.z - Math.sin(p.h) * 2, hint);
    hint = r.index;
    maxErr = Math.max(maxErr, Math.abs(r.distance - d));
  }
  check(maxErr < 3, `progress tracking is continuous (max error ${maxErr.toFixed(2)} m)`);
  // forks: driving the short cut / bypass moves progress forward from the fork to the join
  for (const sp of stage.splits) {
    let h2 = Math.round(sp.from);
    let prev = sp.from, back = 0;
    for (const b of sp.samples) {
      const r = projectOnStage(stage, b.x, b.z, h2);
      h2 = r.index;
      back = Math.max(back, prev - r.distance);
      prev = r.distance;
    }
    check(back < 3 && Math.abs(prev - sp.to) < 30, `fork ${sp.index + 1} (${sp.kind}, ${Math.round(sp.length)} m vs ${Math.round(sp.to - sp.from)} m) counts as progress (ends at ${Math.round(prev)} / ${Math.round(sp.to)})`);
  }
}

if (failures) {
  console.log(`\n${failures} FAILED`);
  process.exit(1);
}
console.log('\nAll stages valid');
