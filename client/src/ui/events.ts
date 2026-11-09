/** Championship hub (service park) and Daily Challenge screens. */
import {
  DAILY_FINISH_PAY,
  MEDAL_PAY,
  TEAMS,
  WEATHER,
  dailyChallenge,
  dailyKey,
  getStage,
  repairCost,
  vehicleById,
  type DailyChallenge,
  type RallyConfig,
  type TeamId,
} from '@cdr/shared';
import { career, money } from '../career';
import { champ } from '../championship/state';
import { eventCtx } from '../events/context';
import { net, type NetError } from '../multiplayer/NetClient';
import { formatTime, settings } from '../settings';
import { classificationTable } from './classification';
import { h, toast } from './dom';
import type { Nav, Screen } from './screens';

const DAMAGE_ZONE_NAMES = ['Front', 'Left side', 'Right side', 'Rear', 'Windscreen', 'Engine'];
const pct = (v: number) => `${Math.round(v * 100)}%`;

/**
 * Creates a room for the event and shows a "ready" panel with the room code,
 * so a navigator can still jump in before the start.
 */
async function launch(nav: Nav, rally: RallyConfig, title: string, onStart?: () => void) {
  const overlay = h('div', { class: 'overlay' });
  const card = h('div', { class: 'card' }, h('h2', {}, title), h('div', { class: 'sub' }, 'Setting up the stage…'));
  overlay.append(card);
  document.body.append(overlay);
  const close = () => overlay.remove();
  try {
    if (net.room) await net.leave().catch(() => undefined);
    const res = await net.createRoom(settings.get().playerName.trim() || 'Driver', { ...rally, soloEvent: true });
    const code = h('div', { class: 'room-code', 'data-testid': 'room-code', style: 'font-size:46px' }, res.room.code);
    const navState = h('div', { class: 'sub', 'data-testid': 'event-nav' }, 'No navigator yet – they can join with the code above.');
    const off = net.on('room', (r) => {
      const n = r.members.find((m) => m.role === 'navigator');
      navState.textContent = n ? `Navigator: ${n.name}${n.connected ? '' : ' (reconnecting)'}` : 'No navigator yet – they can join with the code above.';
    });
    const go = h('button', { class: 'btn primary big', 'data-testid': 'event-start' }, 'Start stage') as HTMLButtonElement;
    go.onclick = async () => {
      go.disabled = true;
      try {
        onStart?.();
        await net.startRace();
        off();
        close();
        nav.go('drive');
      } catch (e) {
        toast((e as NetError).message, 'bad');
        go.disabled = false;
      }
    };
    const cancel = h('button', { class: 'btn' }, 'Cancel');
    cancel.onclick = async () => {
      off();
      close();
      await net.leave().catch(() => undefined);
    };
    card.replaceChildren(h('h2', {}, title), h('div', { class: 'sub' }, 'Navigator joins with this code (optional):'), code, navState, h('div', { class: 'actions' }, go, cancel));
  } catch (e) {
    close();
    toast((e as NetError).message, 'bad');
  }
}

function header(nav: Nav, title: string) {
  return h(
    'div',
    { class: 'screen-header' },
    h('button', { class: 'back-btn', onclick: () => nav.go('play') }, '← Play'),
    h('h2', {}, title),
    h('div', { style: 'margin-left:auto' }, h('span', { class: 'money-chip', 'data-testid': 'event-money' }, money(career.get().money))),
  );
}

// ------------------------------------------------------------------ championship
export function championshipScreen(nav: Nav): Screen {
  // A round that was left half way (tab closed, quit) counts as a retirement.
  const s0 = champ.get();
  if (s0?.inProgress) {
    champ.finishRound(null, [], s0.carry, 0);
    toast('You left the last round early – recorded as a retirement.', 'bad', 5000);
  }
  const body = h('div', { class: 'champ-wrap' });
  const el = h('div', { class: 'screen' }, header(nav, 'Championship'), body);
  const redraw = () => {
    body.replaceChildren(...build());
    const chip = el.querySelector('[data-testid=event-money]');
    if (chip) chip.textContent = money(career.get().money);
  };

  const teamCard = (id: TeamId) => {
    const t = TEAMS[id];
    const car = t.carId ? vehicleById(t.carId).name : 'Your own car';
    return h(
      'div',
      { class: 'team-card', style: `--team:#${t.colour.toString(16).padStart(6, '0')}` },
      h('div', { class: 'team-name' }, t.name),
      h('div', { class: 'team-meta' }, `${car}${t.salary ? ` · ${money(t.salary)} per round` : ''}`),
      h('div', { class: 'team-meta' }, id === 'privateer' ? 'You pay for your own repairs.' : `Free repairs · goal: top ${t.goal} each round`),
    );
  };

  const build = (): HTMLElement[] => {
    const s = champ.get();
    if (!s) {
      return [
        h('div', { class: 'panel champ-intro' },
          h('div', { class: 'panel-title' }, 'Career championship'),
          h('p', {}, 'Six rounds a season against a field of eleven drivers. Score points (25-18-15-12-10-8-6-4-2-1), get noticed and get picked up by a team. Teams give you a better car, a salary and free repairs – but miss their goal twice in a row and you are dropped.'),
          h('p', {}, 'Damage carries over between rounds. No restarts. Three of your closest rivals race you on the stage.'),
          h('button', { class: 'btn primary big', 'data-testid': 'champ-start', onclick: () => { champ.startSeason(); redraw(); } }, 'Start season 1'),
        ),
        h('div', { class: 'panel' }, h('div', { class: 'panel-title' }, 'Teams'), h('div', { class: 'team-grid' }, ...(Object.keys(TEAMS) as TeamId[]).map(teamCard))),
      ];
    }

    const out: HTMLElement[] = [];
    const team = TEAMS[s.team];
    const seasonDone = s.round >= s.schedule.length;
    const standings = champ.standings();
    const myPos = champ.standingsPosition();

    // ---- banner: season / round / team
    out.push(
      h('div', { class: 'panel champ-banner', style: `--team:#${team.colour.toString(16).padStart(6, '0')}` },
        h('div', {}, h('div', { class: 'k' }, `SEASON ${s.season}`), h('div', { class: 'v', 'data-testid': 'champ-round' }, seasonDone ? 'Season complete' : `Round ${s.round + 1} of ${s.schedule.length}`)),
        h('div', {}, h('div', { class: 'k' }, 'TEAM'), h('div', { class: 'v', 'data-testid': 'champ-team' }, team.name)),
        h('div', {}, h('div', { class: 'k' }, 'STANDINGS'), h('div', { class: 'v' }, `P${myPos} · ${s.points.player ?? 0} pts`)),
        s.titles ? h('div', {}, h('div', { class: 'k' }, 'TITLES'), h('div', { class: 'v' }, `🏆 ${s.titles}`)) : null,
      ),
    );

    // ---- last round news
    const sum = s.lastSummary;
    if (sum) {
      const news: string[] = [];
      news.push(sum.position === null ? `Round ${sum.round + 1}: retired, no points.` : `Round ${sum.round + 1}: P${sum.position}, +${sum.pointsGained} points, ${money(sum.prize.total)} earned.`);
      if (sum.dropped) news.push(`You missed the team's goal twice in a row and have been dropped. You are a privateer again.`);
      if (sum.seasonDone) news.push(sum.championPosition === 1 ? 'YOU ARE THE CHAMPION!' : `Season finished: P${sum.championPosition} in the championship.`);
      out.push(h('div', { class: `panel champ-news ${sum.dropped ? 'bad' : ''}`, 'data-testid': 'champ-news' }, ...news.map((n) => h('div', {}, n))));
    }

    // ---- team offer
    if (s.offer) {
      const o = TEAMS[s.offer];
      out.push(
        h('div', { class: 'panel champ-offer', 'data-testid': 'champ-offer' },
          h('div', { class: 'panel-title' }, 'Contract offer!'),
          h('p', {}, `${o.name} want you to drive for them.`),
          teamCard(s.offer),
          h('div', { class: 'actions' },
            h('button', { class: 'btn primary', 'data-testid': 'offer-accept', onclick: () => { champ.acceptOffer(); toast(`Welcome to ${o.name}!`, 'ok'); redraw(); } }, 'Sign'),
            h('button', { class: 'btn', onclick: () => { champ.declineOffer(); redraw(); } }, 'Decline'),
          ),
        ),
      );
    }

    const cols = h('div', { class: 'champ-cols' });
    out.push(cols);
    const left = h('div', { class: 'champ-col' });
    const right = h('div', { class: 'champ-col' });
    cols.append(left, right);

    // ---- service park
    const { cost, teamPays } = champ.repairQuote();
    const car = champ.carForRound();
    const svc = h('div', { class: 'panel', 'data-testid': 'service' }, h('div', { class: 'panel-title' }, 'Service park'));
    svc.append(h('div', { class: 'setup-desc' }, `${vehicleById(car.carId).name}${team.carId ? ` (${team.name} car)` : ' (your car)'}`));
    const grid = h('div', { class: 'dmg-grid' });
    DAMAGE_ZONE_NAMES.forEach((name, i) => grid.append(h('div', { class: `dmg-cell ${s.carry.zones[i] > 0.5 ? 'bad' : s.carry.zones[i] > 0.15 ? 'warn' : ''}` }, h('span', {}, name), h('b', {}, pct(s.carry.zones[i])))));
    svc.append(grid);
    const bodyCost = cost - repairCost(s.carry.zones, [0, 0, 0, 0]);
    const doRepair = (what: 'body' | 'all') => {
      const r = champ.repair(what);
      if (!r.ok) toast(r.reason ?? 'Could not repair', 'bad');
      redraw();
    };
    if (cost > 0) {
      svc.append(
        h('div', { class: 'setup-desc' }, teamPays ? 'The team pays for repairs.' : `Repairs: ${money(cost)} in total.`),
        h('div', { class: 'actions' },
          h('button', { class: 'btn primary', 'data-testid': 'repair-all', onclick: () => doRepair('all') }, teamPays ? 'Repair everything (free)' : `Repair everything – ${money(cost)}`),
          bodyCost > 0 ? h('button', { class: 'btn', onclick: () => doRepair('body') }, teamPays ? 'Body only' : `Body – ${money(bodyCost)}`) : null,
        ),
      );
    } else {
      svc.append(h('div', { class: 'setup-desc' }, 'The car is in perfect shape.'));
    }
    if (s.team === 'privateer') svc.append(h('button', { class: 'btn', style: 'margin-top:8px', onclick: () => nav.go('garage') }, 'Garage – change car & upgrades'));
    left.append(svc);

    // ---- next round / season end
    if (seasonDone) {
      left.append(
        h('div', { class: 'panel' },
          h('div', { class: 'panel-title' }, `Season ${s.season} final`),
          h('p', {}, myPos === 1 ? 'Champion! The trophy is yours.' : `You finished P${myPos} in the championship.`),
          h('button', { class: 'btn primary big', 'data-testid': 'champ-next-season', onclick: () => { champ.startSeason(); redraw(); } }, `Start season ${s.season + 1}`),
        ),
      );
    } else {
      const round = s.schedule[s.round];
      const stage = getStage(round.stageId)!;
      const rivals = champ.onTrackRivals();
      const start = h('button', { class: 'btn primary big', 'data-testid': 'champ-go' }, `Go to round ${s.round + 1}`) as HTMLButtonElement;
      start.onclick = () => {
        eventCtx.set({ kind: 'championship', season: s.season, round: s.round, entrants: rivals, carId: car.carId, upgrades: car.upgrades, carry: s.carry });
        void launch(nav, { stageId: round.stageId, weather: round.weather, aiCount: rivals.length, aiSkill: 'hard' }, `Round ${s.round + 1} – ${stage.def.name}`, () => champ.markStarted());
      };
      left.append(
        h('div', { class: 'panel champ-next' },
          h('div', { class: 'panel-title' }, `Next: round ${s.round + 1}`),
          h('div', { class: 'stage-name', style: 'font-size:22px' }, stage.def.name),
          h('div', { class: 'stage-meta' }, `${stage.def.location} · ${((stage.finishDistance - stage.startDistance) / 1000).toFixed(1)} km · ${WEATHER[round.weather].name}`),
          h('div', { class: 'setup-desc' }, `On the stage with you: ${rivals.map((r) => r.name).join(', ')}.`),
          team.carId ? h('div', { class: 'setup-desc' }, `Team goal: finish in the top ${team.goal}.${s.misses ? ` You missed it last round – miss again and you're out.` : ''}`) : null,
          start,
        ),
      );
    }

    // ---- standings
    const table = h('div', { class: 'leaderboard', 'data-testid': 'champ-standings' }, h('div', { class: 'panel-title' }, 'Championship standings'));
    standings.forEach((r, i) => {
      table.append(
        h('div', { class: `lb-row ${r.you ? 'you' : ''}` },
          h('span', { class: 'pos' }, String(i + 1)),
          h('span', { class: 'who' }, r.you ? 'You' : r.name, h('span', { class: 'team-tag' }, TEAMS[r.team].short)),
          h('span', { class: 't' }, `${r.points} pts`),
        ),
      );
    });
    right.append(h('div', { class: 'panel' }, table));

    // ---- calendar
    const cal = h('div', { class: 'panel' }, h('div', { class: 'panel-title' }, 'Calendar'));
    s.schedule.forEach((r, i) => {
      const res = s.results.find((x) => x.round === i);
      cal.append(
        h('div', { class: `cal-row ${i === s.round ? 'next' : ''}` },
          h('span', {}, `R${i + 1}`),
          h('span', {}, getStage(r.stageId)!.def.name),
          h('span', {}, WEATHER[r.weather].name),
          h('span', {}, res ? (res.playerPosition === null ? 'DNF' : `P${res.playerPosition}`) : i === s.round ? 'next' : ''),
        ),
      );
    });
    right.append(cal);
    const last = s.results[s.results.length - 1];
    if (last) right.append(h('div', { class: 'panel' }, classificationTable(last.classification, 12)));
    return out;
  };

  redraw();
  return { el };
}

// ------------------------------------------------------------------ daily
interface BoardRow { name: string; timeMs: number }

export function dailyScreen(nav: Nav): Screen {
  const date = dailyKey();
  const body = h('div', { class: 'champ-wrap' }, h('div', { class: 'panel' }, 'Loading today\'s challenge…'));
  const el = h('div', { class: 'screen' }, header(nav, 'Daily challenge'), body);
  let disposed = false;

  const show = (ch: DailyChallenge, board: BoardRow[] | null) => {
    if (disposed) return;
    const stage = getStage(ch.stageId)!;
    const car = vehicleById(ch.carId);
    const me = career.get().daily;
    const mine = me.date === ch.date ? me : null;
    const target = (m: 'gold' | 'silver' | 'bronze', icon: string) =>
      h('div', { class: `medal-row ${mine && mine.bestMs !== null && mine.bestMs <= ch.targets[m] ? 'got' : ''}` }, h('span', {}, `${icon} ${m[0].toUpperCase()}${m.slice(1)}`), h('span', {}, formatTime(ch.targets[m])), h('span', {}, `+${money(MEDAL_PAY[m])}`));
    const start = h('button', { class: 'btn primary big', 'data-testid': 'daily-go' }, mine?.finished ? 'Try again' : 'Start the challenge');
    start.onclick = () => {
      eventCtx.set({ kind: 'daily', date: ch.date, carId: ch.carId });
      void launch(nav, { stageId: ch.stageId, weather: ch.weather, aiCount: 0, aiSkill: 'medium', daily: ch.date }, `Daily – ${stage.def.name}`);
    };
    const boardEl = h('div', { class: 'leaderboard', 'data-testid': 'daily-board' }, h('div', { class: 'panel-title' }, 'Today\'s leaderboard'));
    if (board === null) boardEl.append(h('div', { class: 'setup-desc' }, 'The leaderboard is only available on the online server.'));
    else if (!board.length) boardEl.append(h('div', { class: 'setup-desc' }, 'No times yet today – be the first!'));
    const myName = settings.get().playerName.trim() || 'Driver';
    board?.forEach((r, i) =>
      boardEl.append(h('div', { class: `lb-row ${r.name === myName ? 'you' : ''}` }, h('span', { class: 'pos' }, String(i + 1)), h('span', { class: 'who' }, r.name), h('span', { class: 't' }, formatTime(r.timeMs)))),
    );
    body.replaceChildren(
      h('div', { class: 'champ-cols' },
        h('div', { class: 'champ-col' },
          h('div', { class: 'panel daily-card' },
            h('div', { class: 'k' }, `DAILY · ${ch.date}`),
            h('div', { class: 'stage-name', style: 'font-size:26px' }, stage.def.name),
            h('div', { class: 'stage-meta' }, `${stage.def.location} · ${((stage.finishDistance - stage.startDistance) / 1000).toFixed(1)} km · ${WEATHER[ch.weather].name}`),
            h('div', { class: 'setup-desc' }, `Everyone drives the same loan car today: a stock ${car.name}. No upgrades, no AI – just you, your navigator and the clock. New challenge every day (UTC).`),
            target('gold', '🥇'), target('silver', '🥈'), target('bronze', '🥉'),
            h('div', { class: 'setup-desc' }, `First finish of the day: +${money(DAILY_FINISH_PAY)}. A better medal later pays the difference.`),
            h('div', { class: 'daily-mine', 'data-testid': 'daily-mine' }, mine?.bestMs != null ? `Your best today: ${formatTime(mine.bestMs)}${mine.medal !== 'none' ? ` · ${mine.medal} medal` : ''}` : 'You have not driven today\'s challenge yet.'),
            start,
          ),
        ),
        h('div', { class: 'champ-col' }, h('div', { class: 'panel' }, boardEl)),
      ),
    );
  };

  (async () => {
    try {
      const base = import.meta.env.VITE_SERVER_URL || '';
      const res = await fetch(`${base}/api/daily`);
      const data = (await res.json()) as { challenge: DailyChallenge; board: BoardRow[] };
      show(data.challenge, data.board);
    } catch {
      show(dailyChallenge(date), null);
    }
  })();
  return { el, dispose: () => (disposed = true) };
}
