import { TEAMS, pointsFor, type Classified } from '@cdr/shared';
import { h } from './dom';

export function formatMs(ms: number) {
  const m = Math.floor(ms / 60000);
  const sec = (ms % 60000) / 1000;
  return `${m}:${sec.toFixed(2).padStart(5, '0')}`;
}

/** 12-driver round classification with points. */
export function classificationTable(rows: Classified[], limit = 12) {
  const best = rows.find((r) => r.timeMs !== null)?.timeMs ?? 0;
  const el = h('div', { class: 'leaderboard', 'data-testid': 'classification' }, h('div', { class: 'panel-title', style: 'margin:16px 0 6px' }, 'Round classification'));
  rows.slice(0, limit).forEach((r, i) => {
    const pts = r.timeMs === null ? 0 : pointsFor(i + 1);
    el.append(
      h('div', { class: `lb-row five ${r.id === 'player' ? 'you' : ''}` },
        h('span', { class: 'pos' }, r.timeMs === null ? 'DNF' : String(i + 1)),
        h('span', { class: 'who' }, `${r.name}${r.id === 'player' ? ' (you)' : ''}`, h('span', { class: 'team-tag' }, TEAMS[r.team].short)),
        h('span', { class: 't' }, r.timeMs === null ? '—' : formatMs(r.timeMs)),
        h('span', { class: 'gap' }, r.timeMs !== null && i > 0 ? `+${((r.timeMs - best) / 1000).toFixed(2)}` : pts ? '' : ''),
        h('span', { class: 'pts' }, pts ? `+${pts}` : ''),
      ),
    );
  });
  return el;
}
