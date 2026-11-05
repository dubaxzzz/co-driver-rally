import type { BuiltStage, RaceResult } from '@cdr/shared';
import { formatTime } from '../settings';
import { h } from './dom';

export interface ResultAction {
  label: string;
  primary?: boolean;
  onClick: () => void;
}

/** Stage results card – identical for driver and navigator. */
export function resultsOverlay(result: RaceResult, stage: BuiltStage, actions: ResultAction[]) {
  const stat = (k: string, v: string) => h('div', {}, h('div', { class: 'k' }, k), h('div', { class: 'v' }, v));
  const splits = h('div', { class: 'splits' });
  result.splits.forEach((s) => splits.append(h('div', {}, h('span', {}, `Checkpoint ${s.index + 1}`), h('span', {}, formatTime(s.timeMs)))));
  splits.append(h('div', {}, h('span', {}, 'Finish'), h('span', {}, formatTime(result.timeMs))));
  return h(
    'div',
    { class: 'overlay', 'data-testid': 'results' },
    h(
      'div',
      { class: 'card' },
      h('h2', {}, 'Stage complete'),
      h('div', { class: 'sub' }, `${stage.def.name} · ${stage.def.location}`),
      h('div', { class: 'result-time', 'data-testid': 'result-time' }, formatTime(result.timeMs)),
      h(
        'div',
        { class: 'stats-grid' },
        stat('AVG SPEED', `${result.avgSpeedKmh} km/h`),
        stat('TOP SPEED', `${result.topSpeedKmh} km/h`),
        stat('RESETS', String(result.resets)),
        stat('DISTANCE', `${(result.distanceM / 1000).toFixed(2)} km`),
        stat('CHECKPOINTS', `${result.splits.length}/${stage.checkpoints.length}`),
        stat('SURFACE', stage.def.surface.toUpperCase()),
      ),
      splits,
      h(
        'div',
        { class: 'actions' },
        ...actions.map((a) => h('button', { class: `btn ${a.primary ? 'primary' : ''}`, onclick: a.onClick }, a.label)),
      ),
    ),
  );
}
