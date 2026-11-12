import {
  ROOM_CODE_LENGTH,
  STAGE_DEFS,
  SURFACES,
  WEATHER,
  WEATHER_IDS,
  getStage,
  type RallyConfig,
  type RoomSnapshot,
} from '@cdr/shared';
import { net, type NetError } from '../multiplayer/NetClient';
import { MapView } from '../navigator/MapView';
import { formatTime, settings, type Settings } from '../settings';
import { career, money } from '../career';
import { bestKey, TEAMS, VEHICLES, dailyChallenge, dailyKey, vehicleById, MEDAL_PAY, STARTING_MONEY } from '@cdr/shared';
import { champ } from '../championship/state';
import { adminCall, fetchLimited, timeLeft } from './events';
import { h, screenHeader, toast } from './dom';

export interface Screen {
  el: HTMLElement;
  dispose?: () => void;
}

export interface Nav {
  go: (route: string) => void;
}

function serverStatusLine() {
  const dot = h('span', { class: 'status-dot' });
  const text = h('span', {}, '');
  const detail = h('div', { style: 'color:#ff8b97;font-size:12px;margin-top:6px;max-width:420px;text-transform:none;letter-spacing:0;line-height:1.5', 'data-testid': 'conn-detail' }, '');
  const update = () => {
    const s = net.status;
    dot.className = `status-dot ${s === 'connected' ? 'ok' : s === 'disconnected' ? 'bad' : 'warn'}`;
    text.textContent = s === 'connected' ? 'Server online' : s === 'disconnected' ? 'Server offline' : 'Connecting…';
    text.title = net.lastError ?? '';
    detail.textContent = s !== 'connected' && net.lastError ? net.lastError : '';
  };
  update();
  const off = net.on('status', update);
  return { el: h('span', {}, dot, text, detail), dispose: off };
}

function playerName(fallback: string) {
  return settings.get().playerName.trim() || fallback;
}

// ------------------------------------------------------------------ menu
export function menuScreen(nav: Nav): Screen {
  const status = serverStatusLine();
  const car = career.activeDef();
  const save = career.get();
  const ch = dailyChallenge(dailyKey());
  const dStage = getStage(ch.stageId);
  const myDaily = save.daily.date === ch.date ? save.daily : null;
  const cs = champ.get();

  const navBtn = (label: string, sub: string, route: string, primary = false, i = 0, id = '') => {
    const b = h('button', { class: `mm-btn ${primary ? 'primary' : ''}`, 'data-testid': id, style: `animation-delay:${120 + i * 70}ms` },
      h('span', { class: 'mm-btn-label' }, label),
      h('span', { class: 'mm-btn-sub' }, sub),
      h('span', { class: 'mm-btn-arrow' }, '→'),
    );
    b.onclick = () => nav.go(route);
    return b;
  };
  const stat = (name: string, v: number) =>
    h('div', { class: 'mm-stat' }, h('span', {}, name), h('div', { class: 'mm-bar' }, h('i', { style: `width:${v * 10}%` })));
  const card = (k: string, title: string, body: Array<Node | string | null>, route: string, i: number, id: string) => {
    const c = h('button', { class: 'mm-card', 'data-testid': id, style: `animation-delay:${360 + i * 90}ms` }, h('div', { class: 'mm-card-k' }, k), h('div', { class: 'mm-card-t' }, title), ...body);
    c.onclick = () => nav.go(route);
    return c;
  };

  const medal = myDaily?.medal && myDaily.medal !== 'none' ? `${myDaily.medal === 'gold' ? '🥇' : myDaily.medal === 'silver' ? '🥈' : '🥉'} ${myDaily.medal}` : myDaily?.finished ? 'No medal yet' : 'Not driven yet';
  const el = h(
    'div',
    { class: 'screen mm' },
    h('div', { class: 'mm-vignette' }),
    h('header', { class: 'mm-top' },
      h('div', { class: 'mm-top-right' },
        h('span', { class: 'mm-status', 'data-testid': 'conn-status' }, status.el),
        h('span', { class: 'mm-bank', 'data-testid': 'menu-money' }, money(save.money)),
      ),
    ),
    h('main', { class: 'mm-main' },
      h('div', { class: 'mm-hero' },
        h('div', { class: 'mm-kicker' }, h('i', {}), 'Night stage · Rain · Zero visibility'),
        h('h1', { class: 'mm-title' }, h('span', {}, 'CO-DRIVER'), h('span', { class: 'outline' }, 'RALLY')),
        h('p', { class: 'mm-tag' }, 'You can barely see the road. Your navigator can. Drive blind, trust their voice.'),
      ),
      h('nav', { class: 'mm-nav' },
        navBtn('Play', 'Championship · daily · lobbies', 'play', true, 0, 'menu-play'),
        navBtn('Garage', 'Cars · upgrades · paint', 'garage', false, 1, 'menu-garage'),
        navBtn('Settings', 'Audio · graphics · controls', 'settings', false, 2, 'menu-settings'),
      ),
    ),
    h('aside', { class: 'mm-cards' },
      card('YOUR CAR', car.name, [stat('Power', car.stats.power), stat('Handling', car.stats.handling), stat('Braking', car.stats.braking)], 'garage', 0, 'menu-car'),
      card(`DAILY · ${ch.date}`, dStage?.def.name ?? 'Daily challenge', [h('div', { class: 'mm-card-m' }, `${WEATHER[ch.weather].name} · ${vehicleById(ch.carId).name}`), h('div', { class: 'mm-card-m strong' }, medal)], 'daily', 1, 'menu-daily'),
      card('CHAMPIONSHIP', cs ? `Season ${cs.season}` : 'Start your career', [h('div', { class: 'mm-card-m' }, cs ? (cs.round >= cs.schedule.length ? 'Season complete' : `Round ${cs.round + 1}/${cs.schedule.length} · ${TEAMS[cs.team].name}`) : 'Six rounds · teams · contracts'), cs ? h('div', { class: 'mm-card-m strong' }, `P${champ.standingsPosition()} · ${cs.points.player ?? 0} pts`) : null], 'championship', 2, 'menu-champ'),
    ),
  );

  // a limited event on? show it first in the cards
  void fetchLimited().then((evs) => {
    if (!evs.length) return;
    const ev = evs[0];
    const c = card('LIMITED EVENT', ev.name, [h('div', { class: 'mm-card-m' }, `${getStage(ev.stageId)?.def.name ?? ''} · prize ${money(ev.prize)}`), h('div', { class: 'mm-card-m strong' }, evs.length > 1 ? `${timeLeft(ev.endsAt)} · +${evs.length - 1} more` : timeLeft(ev.endsAt))], 'limited', 0, 'menu-limited');
    c.classList.add('limited');
    el.querySelector('[data-testid=menu-car]')?.remove(); // keep three cards
    el.querySelector('.mm-cards')?.prepend(c);
  });

  // 3D backdrop loads after the menu is on screen (Three.js is a big download)
  let scene: { dispose(): void } | null = null;
  let disposed = false;
  requestAnimationFrame(() =>
    void import('./menuScene').then(({ MenuScene }) => {
      if (disposed) return;
      try {
        scene = new MenuScene(el);
        el.classList.add('has-3d');
      } catch (e) {
        console.warn('menu 3D unavailable', e);
      }
    }),
  );
  return { el, dispose: () => { disposed = true; status.dispose(); scene?.dispose(); } };
}

// ------------------------------------------------------------------ create / lobby
/** Lobby: 'crew' = room code + navigator; 'solo' = just pick the stage and go. */
export function lobbyScreen(nav: Nav, mode: 'crew' | 'solo' = 'crew'): Screen {
  const solo = mode === 'solo';
  const status = serverStatusLine();
  const codeEl = h('div', { class: 'room-code', 'data-testid': 'room-code' }, '····');
  const hint = h('div', { class: 'join-hint' }, 'Creating rally…');
  const players = h('div', {});
  const startBtn = h('button', { class: 'btn primary big', disabled: true, 'data-testid': 'start-stage' }, 'Start stage') as HTMLButtonElement;
  const leaveBtn = h('button', { class: 'btn danger', 'data-testid': 'leave-rally' }, 'Leave rally');
  const readyBtn = h('button', { class: 'btn', 'data-testid': 'ready-btn' }, 'Ready') as HTMLButtonElement;
  const seatCtl = h('div', { class: 'seat-ctl' });
  const startNote = h('div', { class: 'setup-desc', 'data-testid': 'start-note' }, '');
  const setupPanel = h('div', { class: 'panel setup' });
  const unsubs: Array<() => void> = [status.dispose];
  let current: RallyConfig = { ...settings.get().rally };

  // ---- rally setup pickers ----
  const stageGrid = h('div', { class: 'stage-grid' });
  const bestEls = new Map<string, HTMLElement>();
  const stageCards = new Map<string, HTMLElement>();
  const previews: MapView[] = [];
  for (const def of STAGE_DEFS) {
    const stage = getStage(def.id)!;
    const mv = new MapView(stage);
    mv.mode = 'full';
    mv.labels = false;
    previews.push(mv);
    const surfaces = [...new Set(stage.surfaceSpans.map((x) => SURFACES[x.surface].name))].join(' · ');
    const card = h(
      'button',
      { class: 'stage-card', 'data-testid': `stage-${def.id}` },
      mv.canvas,
      h('div', { class: 'stage-name' }, def.name),
      h('div', { class: 'stage-meta' }, `${def.location} · ${((stage.finishDistance - stage.startDistance) / 1000).toFixed(1)} km`),
      h('div', { class: 'stage-meta' }, `${surfaces}${stage.bridges.length ? ` · ${stage.bridges.length} bridge${stage.bridges.length > 1 ? 's' : ''}` : ''}`),
    );
    card.title = def.description;
    card.onclick = () => choose({ stageId: def.id, weather: def.defaultWeather });
    const best = h('div', { class: 'stage-best' }, '');
    card.append(best);
    bestEls.set(def.id, best);
    stageCards.set(def.id, card);
    stageGrid.append(card);
  }
  const weatherRow = h('div', { class: 'chip-row' });
  const weatherBtns = new Map<string, HTMLElement>();
  for (const id of WEATHER_IDS) {
    const w = WEATHER[id];
    const b = h('button', { class: 'chip-btn', title: w.description, 'data-testid': `weather-${id}` }, w.name);
    b.onclick = () => choose({ weather: id });
    weatherBtns.set(id, b);
    weatherRow.append(b);
  }
  const weatherDesc = h('div', { class: 'setup-desc' }, '');
  const showConfig = (c: RallyConfig) => {
    bestEls.forEach((el, id) => {
      const b = career.best(bestKey(id, c.weather));
      el.textContent = b === null ? '' : `Best (${WEATHER[c.weather].name}): ${formatTime(b)}`;
    });
    current = { stageId: c.stageId, weather: c.weather, aiCount: 0, aiSkill: c.aiSkill };
    stageCards.forEach((el, id) => el.classList.toggle('sel', id === c.stageId));
    weatherBtns.forEach((el, id) => el.classList.toggle('sel', id === c.weather));
    weatherDesc.textContent = WEATHER[c.weather].description;
  };
  const choose = async (patch: Partial<RallyConfig>) => {
    const next = { ...current, ...patch };
    showConfig(next);
    settings.update({ rally: next });
    if (!net.room) return;
    try {
      await net.configure(patch);
    } catch (e) {
      toast((e as NetError).message, 'bad');
    }
  };
  showConfig(current);

  const goRace = (room: RoomSnapshot) => {
    const phase = room.race.phase;
    if (phase !== 'countdown' && phase !== 'racing' && phase !== 'finished') return false;
    const me = net.me();
    if (me?.role === 'navigator') nav.go('navigator');
    else if (me && room.race.drivers.some((d) => d.playerId === me.playerId)) nav.go('drive');
    else return false;
    return true;
  };

  const render = (room: RoomSnapshot) => {
    codeEl.textContent = room.code;
    const url = `${location.origin}${location.pathname}#/join/${room.code}`;
    hint.innerHTML = '';
    const copy = h('button', { class: 'copy-link', title: url }, 'Copy invite link');
    copy.onclick = () => void navigator.clipboard?.writeText(url).then(() => toast('Invite link copied', 'ok'), () => toast(url));
    hint.append(h('p', {}, 'Friends choose ', h('b', {}, 'Play → Join lobby'), ' and type this code. Up to 4 players – each driver can bring a navigator.'), copy);
    const me = net.me();
    const host = net.isHost;
    const inLobby = room.race.phase === 'lobby';

    // ---- players
    players.innerHTML = '';
    const drivers = room.members.filter((m) => m.role === 'driver');
    for (const m of room.members) {
      const isMe = m.playerId === me?.playerId;
      const forName = m.role === 'navigator' ? room.members.find((d) => d.playerId === m.navFor)?.name : null;
      const roleText = m.role === 'driver' ? 'DRIVER' : forName ? `NAVIGATOR · FOR ${forName.toUpperCase()}` : 'NAVIGATOR';
      const state = !m.connected ? 'Reconnecting…' : room.hostId === m.playerId ? 'Host' : m.ready ? 'Ready ✓' : 'Not ready';
      players.append(
        h('div', { class: `player-row ${isMe ? 'me' : ''}`, 'data-testid': `member-${m.name}` },
          h('span', { class: `status-dot ${!m.connected ? 'warn' : room.hostId === m.playerId || m.ready ? 'ok' : ''}` }),
          h('div', {}, h('div', { class: 'role' }, `${room.hostId === m.playerId ? '★ ' : ''}${roleText}`), h('div', { class: 'name' }, `${m.name}${isMe ? ' (you)' : ''}`)),
          h('div', { class: 'state' }, state),
        ),
      );
    }
    for (let i = room.members.length; i < 4; i++) players.append(h('div', { class: 'player-row empty' }, h('span', { class: 'status-dot' }), h('div', {}, h('div', { class: 'role' }, 'OPEN SEAT'), h('div', { class: 'name' }, 'Waiting for a player…'))));

    // ---- my seat
    seatCtl.innerHTML = '';
    if (me && inLobby && !room.race.soloEvent) {
      const driveBtn = h('button', { class: `chip-btn ${me.role === 'driver' ? 'sel' : ''}`, 'data-testid': 'seat-driver' }, '🏎 Drive');
      driveBtn.onclick = () => void net.setRole('driver').catch((e) => toast((e as NetError).message, 'bad'));
      const navBtns = drivers
        .filter((d) => d.playerId !== me.playerId)
        .map((d) => {
          const b = h('button', { class: `chip-btn ${me.role === 'navigator' && me.navFor === d.playerId ? 'sel' : ''}`, 'data-testid': `seat-nav-${d.name}` }, `🗺 Navigate for ${d.name}`);
          b.onclick = () => void net.setRole('navigator', d.playerId).catch((e) => toast((e as NetError).message, 'bad'));
          return b;
        });
      seatCtl.append(h('div', { class: 'panel-title', style: 'margin-top:14px' }, 'Your seat'), h('div', { class: 'chip-row' }, driveBtn, ...navBtns));
    }
    readyBtn.style.display = host || !inLobby ? 'none' : '';
    readyBtn.textContent = me?.ready ? 'Ready ✓ (tap to undo)' : 'Tick ready';
    readyBtn.classList.toggle('primary', !me?.ready);

    // ---- start
    const waiting = room.members.filter((m) => m.connected && m.playerId !== room.hostId && !m.ready);
    startBtn.style.display = host ? '' : 'none';
    startBtn.disabled = !inLobby || !drivers.some((d) => d.connected) || waiting.length > 0;
    startBtn.textContent = drivers.length > 1 ? `Start rally (${drivers.length} cars)` : 'Start stage';
    startNote.textContent = !inLobby
      ? 'A stage is running – you will join the next one.'
      : host
        ? !drivers.length
          ? 'Someone needs to drive.'
          : waiting.length
            ? `Waiting for ${waiting.map((w) => w.name).join(', ')} to tick ready.`
            : drivers.some((d) => !room.members.some((m) => m.navFor === d.playerId))
              ? 'Everyone is ready. Drivers without a navigator will drive blind!'
              : 'Everyone is ready.'
        : `${room.members.find((m) => m.playerId === room.hostId)?.name ?? 'The host'} picks the stage and starts the rally.`;

    // only the host changes the stage
    setupPanel.classList.toggle('readonly', !host);
    showConfig(room.race);
    goRace(room);
  };

  readyBtn.onclick = () => void net.setReady(!net.me()?.ready).catch((e) => toast((e as NetError).message, 'bad'));
  startBtn.onclick = async () => {
    startBtn.disabled = true;
    try {
      await net.startRace();
    } catch (e) {
      toast((e as NetError).message, 'bad');
      startBtn.disabled = false;
    }
  };
  leaveBtn.onclick = async () => {
    await net.leave();
    nav.go('menu');
  };

  unsubs.push(
    net.on('room', render),
    net.on('race', (s) => {
      showConfig(s);
      if (net.room) render({ ...net.room, race: s });
    }),
    net.on('closed', (p) => { toast(p.reason, 'bad'); nav.go('menu'); }),
  );

  (async () => {
    try {
      if (net.room) render(net.room);
      else render((await net.createRoom(playerName('Driver'), solo ? { ...current, soloEvent: true } : current)).room);
    } catch (e) {
      hint.textContent = (e as NetError).message;
      toast((e as NetError).message, 'bad');
    }
  })();

  const el = h(
    'div',
    { class: 'screen' },
    screenHeader('Back', () => leaveBtn.click(), solo ? 'Quick stage' : 'Rally lobby', status.el),
    h(
      'div',
      { class: 'lobby-layout' },
      // side column: who's here and the big buttons (first on phones)
      h(
        'aside',
        { class: 'lobby-side' },
        solo
          ? h('div', { class: 'panel lobby-card' },
              h('div', { class: 'panel-title' }, 'Quick stage'),
              h('div', { class: 'lobby-car' }, career.activeDef().name),
              h('p', { class: 'setup-desc' }, 'Pick a stage and the weather, then go. Every finish earns prize money.'),
              startBtn,
            )
          : h('div', { class: 'panel lobby-card' },
              h('div', { class: 'panel-title' }, 'Room code'),
              codeEl,
              hint,
            ),
        solo
          ? null
          : h('div', { class: 'panel lobby-card' },
              h('div', { class: 'panel-title' }, 'Players'),
              players,
              seatCtl,
              h('div', { class: 'lobby-actions' }, startBtn, readyBtn, leaveBtn),
              startNote,
            ),
      ),
      (setupPanel.append(
        h('div', { class: 'panel-title' }, 'Stage'),
        stageGrid,
        h('div', {}, h('div', { class: 'panel-title' }, 'Weather'), weatherRow, weatherDesc),
      ), setupPanel),
    ),
  );
  // draw the stage previews once they are in the document
  requestAnimationFrame(() => requestAnimationFrame(() => previews.forEach((p) => p.draw(null, 0))));
  return { el, dispose: () => unsubs.forEach((u) => u()) };
}

// ------------------------------------------------------------------ play
function champSub() {
  const s = champ.get();
  if (!s) return 'Start a career: six-round seasons, points, team contracts, carried damage. Get picked up by a works team.';
  if (s.round >= s.schedule.length) return `Season ${s.season} finished – start the next one.`;
  return `Season ${s.season} · round ${s.round + 1} of ${s.schedule.length} · ${TEAMS[s.team].name} · P${champ.standingsPosition()} with ${s.points.player ?? 0} pts`;
}
function dailySub() {
  const ch = dailyChallenge(dailyKey());
  const me = career.get().daily;
  const done = me.date === ch.date && me.finished ? ` · your best ${formatTime(me.bestMs ?? 0)}${me.medal !== 'none' ? ` (${me.medal})` : ''}` : '';
  return `Today: ${getStage(ch.stageId)?.def.name} in ${WEATHER[ch.weather].name.toLowerCase()}, same loan car for everyone. Medals pay up to ${money(MEDAL_PAY.gold)}${done}.`;
}
export function playScreen(nav: Nav): Screen {
  const card = (k: string, title: string, desc: string, route: string, primary = false, id = '') =>
    h('button', { class: `play-card ${primary ? 'primary' : ''}`, onclick: () => nav.go(route), 'data-testid': id }, h('div', { class: 'k' }, k), h('div', { class: 't' }, title), h('div', { class: 'd' }, desc));
  const limitedCard = card('LIMITED TIME', 'Limited events', 'Special events that only run for a while – each pays a prize for finishing.', 'limited', false, 'play-limited');
  limitedCard.classList.add('limited');
  void fetchLimited().then((evs) => {
    const d = limitedCard.querySelector('.d');
    if (d) d.textContent = evs.length ? `${evs.length} on now: ${evs.map((e) => `${e.name} (${timeLeft(e.endsAt)})`).join(' · ')}` : 'No limited events on right now – check back soon.';
  });
  const el = h(
    'div',
    { class: 'screen' },
    screenHeader('Menu', () => nav.go('menu'), 'Play', h('span', { class: 'money-chip' }, money(career.get().money))),
    h(
      'div',
      { class: 'center-wrap play-wrap' },
      h('div', { class: 'play-row-title' }, 'Solo'),
      h(
        'div',
        { class: 'play-grid four' },
        card('SOLO', 'Championship', champSub(), 'championship', true, 'play-championship'),
        card('SOLO', 'Daily challenge', dailySub(), 'daily', false, 'play-daily'),
        card('SOLO', 'Quick stage', 'Any stage, any weather, just you against the clock. Prize money for every finish.', 'solo', false, 'play-solo'),
        limitedCard,
      ),
      h('div', { class: 'play-row-title' }, 'Multiplayer'),
      h(
        'div',
        { class: 'play-grid two' },
        card('MULTIPLAYER', 'Create lobby', 'Host a rally for up to 4 players – race each other with real collisions, each driver with their own navigator.', 'create', false, 'play-create'),
        card('MULTIPLAYER', 'Join lobby', 'Enter a code to join as a driver or a navigator. Navigators earn a 40% share of their driver\'s prize.', 'join', false, 'play-join'),
      ),
    ),
  );
  return { el };
}

// ------------------------------------------------------------------ join
export function joinScreen(nav: Nav, prefill = ''): Screen {
  const status = serverStatusLine();
  const code = h('input', {
    class: 'input code-input',
    maxlength: ROOM_CODE_LENGTH,
    placeholder: 'R7K2',
    autocomplete: 'off',
    autocapitalize: 'characters',
    spellcheck: 'false',
    'data-testid': 'join-code',
  }) as HTMLInputElement;
  code.value = prefill.toUpperCase().slice(0, ROOM_CODE_LENGTH);
  const name = h('input', { class: 'input', maxlength: 16, placeholder: 'Your name', 'data-testid': 'join-name' }) as HTMLInputElement;
  name.value = settings.get().playerName;
  const error = h('div', { class: 'error-text', 'data-testid': 'join-error' }, '');
  const joinBtn = h('button', { class: 'btn primary big', style: 'width:100%', 'data-testid': 'join-btn' }, 'Join rally') as HTMLButtonElement;
  code.addEventListener('input', () => {
    code.value = code.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
    error.textContent = '';
  });
  const submit = async () => {
    error.textContent = '';
    if (code.value.length !== ROOM_CODE_LENGTH) {
      error.textContent = 'Enter the 4-character code shown on the host\'s screen.';
      return;
    }
    joinBtn.disabled = true;
    try {
      if (name.value.trim()) settings.update({ playerName: name.value.trim() });
      await net.joinRoom(code.value, name.value.trim() || 'Player');
      nav.go('lobby');
    } catch (e) {
      error.textContent = (e as NetError).message;
    } finally {
      joinBtn.disabled = false;
    }
  };
  joinBtn.onclick = () => void submit();
  code.addEventListener('keydown', (e) => { if (e.key === 'Enter') void submit(); });
  setTimeout(() => code.focus(), 50);

  const el = h(
    'div',
    { class: 'screen' },
    screenHeader('Play', () => nav.go('play'), 'Join a rally', status.el),
    h(
      'div',
      { class: 'center-wrap' },
      h(
        'div',
        { class: 'panel join-card' },
        h('div', { class: 'panel-title' }, 'Room code'),
        h('p', { class: 'setup-desc' }, 'Type the 4-character code from the host\'s screen. You can pick driver or navigator in the lobby.'),
        h('div', { class: 'field' }, code),
        h('div', { class: 'field' }, h('label', {}, 'Your name'), name),
        error,
        joinBtn,
      ),
    ),
  );
  return { el, dispose: status.dispose };
}

// ------------------------------------------------------------------ settings
export function settingsScreen(nav: Nav): Screen {
  const s = settings.get();
  const seg = <K extends keyof Settings>(key: K, options: Array<[Settings[K], string]>) => {
    const wrap = h('div', { class: 'seg' });
    options.forEach(([val, label]) => {
      const b = h('button', { class: settings.get()[key] === val ? 'sel' : '' }, label);
      b.onclick = () => {
        settings.update({ [key]: val } as Partial<Settings>);
        wrap.querySelectorAll('button').forEach((x) => x.classList.remove('sel'));
        b.classList.add('sel');
      };
      wrap.append(b);
    });
    return wrap;
  };
  const section = (title: string, ...rows: HTMLElement[]) => h('section', { class: 'panel settings-section' }, h('div', { class: 'panel-title' }, title), ...rows);
  const keyRow = (k: string, v: string) => h('div', { class: 'key-row' }, h('span', { class: 'key-k' }, k), h('span', { class: 'key-v' }, v));
  const row = (title: string, desc: string, control: HTMLElement) =>
    h('div', { class: 'setting-row' }, h('div', { class: 'setting-text' }, h('div', { class: 'setting-title' }, title), desc ? h('div', { class: 'desc' }, desc) : null), control);

  const name = h('input', { class: 'input', maxlength: 16, placeholder: 'Your name', style: 'width:220px;font-size:16px' }) as HTMLInputElement;
  name.value = s.playerName;
  name.addEventListener('change', () => settings.update({ playerName: name.value.trim() }));
  const resetBtn = h('button', { class: 'btn danger' }, 'Reset career') as HTMLButtonElement;
  let armed = false;
  resetBtn.onclick = () => {
    if (!armed) {
      armed = true;
      resetBtn.textContent = 'Tap again to confirm';
      setTimeout(() => {
        armed = false;
        resetBtn.textContent = 'Reset career';
      }, 3000);
      return;
    }
    career.reset();
    champ.reset();
    toast('Career reset', 'ok');
    nav.go('settings');
  };
  const vol = h('input', { type: 'range', min: 0, max: 1, step: 0.05 }) as HTMLInputElement;
  vol.value = String(s.volume);
  vol.addEventListener('input', () => settings.update({ volume: Number(vol.value) }));

  const el = h(
    'div',
    { class: 'screen' },
    screenHeader('Menu', () => nav.go('menu'), 'Settings'),
    h(
      'div',
      { class: 'page' },
      h(
        'div',
        { class: 'settings' },
        section('Profile', row('Player name', 'Shown to everyone in your lobby', name)),
        section('Sound',
          row('Audio', 'Engine, gravel, switches and chimes', seg('audioEnabled', [[true, 'On'], [false, 'Off']])),
          row('Volume', 'Master volume', vol),
        ),
        section('Graphics',
          row('Driver visibility', 'Night fog on the stage – Very low means you must trust your co-driver', seg('visibility', [['verylow', 'Very low'], ['low', 'Low'], ['normal', 'Normal']])),
          row('Quality', 'Low: no shadows, fewer trees – for older laptops', seg('quality', [['high', 'High'], ['low', 'Low']])),
          row('Speed units', 'Shown on the dashboards and HUD', seg('units', [['kmh', 'km/h'], ['mph', 'mph']])),
        ),
        section('Career', row('Reset career', `Bank ${money(career.get().money)} · ${Object.keys(career.get().owned).length} car(s). Starts again with ${money(STARTING_MONEY)} and the Kestrel R5.`, resetBtn)),
        adminSection(nav, section, row),
        section('Controls',
          h('div', { class: 'keys' },
            keyRow('Drive', 'W / ↑ throttle · S / ↓ brake & reverse · A D / ← → steer'),
            keyRow('Handbrake', 'Space'),
            keyRow('Reset · Pause', 'R · Esc'),
            keyRow('Switches', 'Click them in the car: ignition, START (hold), lights, wipers, demister…'),
            keyRow('Gamepad', 'RT throttle · LT brake · left stick steer · A/B handbrake · X reset · Start pause'),
            keyRow('Navigator', '↑ look at the road · ↓ look at the tablet · drag to look around · call the stage out loud'),
          ),
        ),
      ),
    ),
  );
  return { el };
}

// ------------------------------------------------------------------ admin panel
const ADMIN_KEY = 'cdr.admin';

/** Settings → Admin: unlock with the admin code (checked by the server). */
function adminSection(
  nav: Nav,
  section: (title: string, ...rows: HTMLElement[]) => HTMLElement,
  row: (title: string, desc: string, control: HTMLElement) => HTMLElement,
): HTMLElement {
  const code = (() => {
    try {
      return sessionStorage.getItem(ADMIN_KEY);
    } catch {
      return null;
    }
  })();
  if (!code) {
    const input = h('input', { class: 'input', type: 'password', placeholder: 'Admin code', maxlength: 40, style: 'width:180px;font-size:16px', 'data-testid': 'admin-code' }) as HTMLInputElement;
    const unlock = h('button', { class: 'btn', 'data-testid': 'admin-unlock' }, 'Unlock') as HTMLButtonElement;
    const tryUnlock = async () => {
      if (!input.value.trim()) return;
      unlock.disabled = true;
      const r = await adminCall('login', input.value.trim());
      unlock.disabled = false;
      if (!r.ok) return toast(r.message ?? 'Wrong admin code.', 'bad');
      try {
        sessionStorage.setItem(ADMIN_KEY, input.value.trim());
      } catch {
        /* ignore */
      }
      toast('Admin panel unlocked', 'ok');
      nav.go('settings');
    };
    unlock.onclick = () => void tryUnlock();
    input.addEventListener('keydown', (e) => e.key === 'Enter' && void tryUnlock());
    return section('Admin', row('Admin code', 'Enter the admin code to open the admin panel', h('div', { class: 'admin-unlock' }, input, unlock)));
  }

  const cars = h('button', { class: 'btn primary', 'data-testid': 'admin-cars' }, 'Give me every car');
  cars.onclick = () => {
    const n = career.adminGiveAllCars();
    toast(n ? `${n} cars added to your garage` : 'You already own every car', 'ok');
    nav.go('settings');
  };
  const cash = h('button', { class: 'btn primary', 'data-testid': 'admin-money' }, '+ $1,000,000');
  cash.onclick = () => {
    career.adminAddMoney(1_000_000);
    toast('$1,000,000 added', 'ok');
    nav.go('settings');
  };
  const lock = h('button', { class: 'btn' }, 'Lock');
  lock.onclick = () => {
    try {
      sessionStorage.removeItem(ADMIN_KEY);
    } catch {
      /* ignore */
    }
    nav.go('settings');
  };

  // ---- create a limited event ----
  const sel = (opts: Array<[string, string]>, testid: string) => {
    const s = h('select', { class: 'input admin-select', 'data-testid': testid }) as HTMLSelectElement;
    for (const [v, l] of opts) s.append(h('option', { value: v }, l));
    return s;
  };
  const name = h('input', { class: 'input', maxlength: 40, placeholder: 'Event name, e.g. Midnight Madness', 'data-testid': 'admin-ev-name' }) as HTMLInputElement;
  const stageSel = sel(STAGE_DEFS.map((d) => [d.id, `${d.name} (${d.location})`]), 'admin-ev-stage');
  const weatherSel = sel(WEATHER_IDS.map((w) => [w, WEATHER[w].name]), 'admin-ev-weather');
  const carSel = sel([['', 'Players bring their own car'], ...VEHICLES.map((v): [string, string] => [v.id, `Loan car: ${v.name}`])], 'admin-ev-car');
  const hoursSel = sel([['1', '1 hour'], ['3', '3 hours'], ['6', '6 hours'], ['24', '1 day'], ['72', '3 days'], ['168', '1 week']], 'admin-ev-hours');
  hoursSel.value = '24';
  const prize = h('input', { class: 'input', type: 'number', min: 0, max: 10000000, step: 1000, value: '25000', 'data-testid': 'admin-ev-prize' }) as HTMLInputElement;
  stageSel.onchange = () => (weatherSel.value = STAGE_DEFS.find((d) => d.id === stageSel.value)?.defaultWeather ?? 'clear');
  stageSel.onchange(new Event('change'));
  const create = h('button', { class: 'btn primary', 'data-testid': 'admin-ev-create' }, 'Create event') as HTMLButtonElement;
  const list = h('div', { class: 'admin-events' });
  const field = (label: string, control: HTMLElement) => h('label', { class: 'admin-field' }, h('span', {}, label), control);
  const refresh = async () => {
    const evs = await fetchLimited();
    list.replaceChildren(...(evs.length ? [] : [h('div', { class: 'desc' }, 'No limited events running.')]));
    for (const ev of evs) {
      const del = h('button', { class: 'btn danger' }, 'End now');
      del.onclick = async () => {
        const r = await adminCall('events/delete', code, { id: ev.id });
        toast(r.ok ? `${ev.name} ended` : r.message ?? 'Could not end it', r.ok ? 'ok' : 'bad');
        void refresh();
      };
      list.append(h('div', { class: 'admin-ev' }, h('div', {}, h('b', {}, ev.name), h('div', { class: 'desc' }, `${getStage(ev.stageId)?.def.name} · ${WEATHER[ev.weather].name} · ${ev.carId ? vehicleById(ev.carId).name : 'own car'} · ${money(ev.prize)} · ${timeLeft(ev.endsAt)} · ${ev.board.length} driver(s)`)), del));
    }
  };
  create.onclick = async () => {
    if (!name.value.trim()) return toast('Give the event a name', 'bad');
    create.disabled = true;
    const r = await adminCall('events', code, {
      event: { name: name.value.trim(), stageId: stageSel.value, weather: weatherSel.value, carId: carSel.value || null, prize: Math.max(0, Number(prize.value) || 0), hours: Number(hoursSel.value) },
    });
    create.disabled = false;
    if (!r.ok) return toast(r.message ?? 'Could not create the event', 'bad');
    toast(`${name.value.trim()} is live for everyone!`, 'ok');
    name.value = '';
    void refresh();
  };
  void refresh();

  return section('Admin',
    row('Garage', 'Unlock every car in the dealership', cars),
    row('Money', 'Add a million dollars to your bank', cash),
    h('div', { class: 'admin-create' },
      h('div', { class: 'setting-title' }, 'Create a limited event'),
      h('div', { class: 'desc' }, 'Everyone sees it on their menu until it ends, with its own leaderboard and a prize for finishing.'),
      h('div', { class: 'admin-form' },
        field('Name', name), field('Stage', stageSel), field('Weather', weatherSel), field('Car', carSel), field('Runs for', hoursSel), field('Prize ($)', prize),
      ),
      create,
    ),
    h('div', { class: 'setting-title', style: 'margin-top:14px' }, 'Running events'),
    list,
    row('Admin mode', 'Lock the panel again on this device', lock),
  );
}
