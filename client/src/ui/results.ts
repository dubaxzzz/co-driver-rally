import type { BuiltStage, RaceResult } from '@cdr/shared';
import { formatTime } from '../settings';
import { h } from './dom';

export interface Standing {
  name: string;
  timeMs: number | null; // null = still on the stage
  you: boolean;
}

export interface ResultAction {
  label: string;
  primary?: boolean;
  onClick: () => void;
}

/** Stage results card – identical for driver and navigator. */
export function resultsOverlay(result: RaceResult, stage: BuiltStage, actions: ResultAction[], standings?: () => Standing[], extra?: HTMLElement) {
  const stat = (k: string, v: string) => h('div', {}, h('div', { class: 'k' }, k), h('div', { class: 'v' }, v));
  const splits = h('div', { class: 'splits' });
  result.splits.forEach((s) => splits.append(h('div', {}, h('span', {}, `Checkpoint ${s.index + 1}`), h('span', {}, formatTime(s.timeMs)))));
  splits.append(h('div', {}, h('span', {}, 'Finish'), h('span', {}, formatTime(result.timeMs))));
  // Leaderboard against the AI crews (they may still be finishing – refreshes live)
  const board = h('div', { class: 'leaderboard', 'data-testid': 'leaderboard' });
  const drawBoard = () => {
    if (!standings) return;
    const list = standings();
    if (list.length < 2) return;
    const sorted = [...list].sort((a, b) => (a.timeMs ?? Infinity) - (b.timeMs ?? Infinity));
    const best = sorted[0].timeMs ?? 0;
    board.innerHTML = '';
    board.append(h('div', { class: 'panel-title', style: 'margin:16px 0 6px' }, 'Stage leaderboard'));
    sorted.forEach((s, i) => {
      const gap = s.timeMs !== null && i > 0 ? `+${((s.timeMs - best) / 1000).toFixed(2)}` : '';
      board.append(
        h('div', { class: `lb-row ${s.you ? 'you' : ''}` },
          h('span', { class: 'pos' }, s.timeMs === null ? '–' : String(i + 1)),
          h('span', { class: 'who' }, s.you ? `${s.name} (you)` : s.name),
          h('span', { class: 't' }, s.timeMs === null ? 'on stage…' : formatTime(s.timeMs)),
          h('span', { class: 'gap' }, gap),
        ),
      );
    });
  };
  drawBoard();
  const timer = setInterval(() => {
    if (!board.isConnected && board.childElementCount) return clearInterval(timer);
    drawBoard();
  }, 500);
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
      board,
      extra ?? null,
      h(
        'div',
        { class: 'actions' },
        ...actions.map((a) => h('button', { class: `btn ${a.primary ? 'primary' : ''}`, onclick: a.onClick }, a.label)),
      ),
    ),
  );
}
