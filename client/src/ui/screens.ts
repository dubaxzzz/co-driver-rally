import {
  DEFAULT_STAGE_ID,
  MAX_AI,
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
import { bestKey, TEAMS, dailyChallenge, dailyKey } from '@cdr/shared';
import { champ } from '../championship/state';
import { h, toast } from './dom';

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
    const what = net.mode === 'p2p' ? 'Online' : 'Server online';
    text.textContent = s === 'connected' ? what : s === 'disconnected' ? (net.mode === 'p2p' ? 'Not connected – retrying…' : 'Server offline') : 'Connecting…';
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
  const stage = getStage(settings.get().rally.stageId) ?? getStage(DEFAULT_STAGE_ID)!;
  const preview = new MapView(stage);
  preview.mode = 'full';
  let raf = 0;
  const draw = () => {
    preview.draw(null, 0);
    raf = requestAnimationFrame(draw);
  };

  const btn = (label: string, sub: string, onClick: (b: HTMLButtonElement) => void, primary = false, delay = 0) => {
    const b = h('button', { class: `menu-btn ${primary ? 'primary' : ''}` }, h('span', {}, label), h('small', {}, sub));
    b.style.animationDelay = `${delay}ms`;
    b.onclick = () => onClick(b);
    return b;
  };

  const el = h(
    'div',
    { class: 'screen' },
    h(
      'div',
      { class: 'menu' },
      h(
        'div',
        { class: 'menu-left' },
        h('div', { class: 'brand' }, h('span', { class: 'co' }, 'CO-'), 'DRIVER', h('br'), 'RALLY'),
        h('div', { class: 'tagline' }, 'One drives · One navigates'),
        btn('Play', 'Solo · create a lobby · join a lobby', () => nav.go('play'), true, 0),
        btn('Garage', 'Your cars, dealership, upgrades', () => nav.go('garage'), false, 80),
        btn('Settings', 'Audio, graphics, controls', () => nav.go('settings'), false, 160),
        h('div', { class: 'menu-bank' }, h('span', {}, 'BANK'), h('span', { class: 'money-chip', 'data-testid': 'menu-money' }, money(career.get().money))),
        h('div', { style: 'margin-top:18px;color:var(--muted);font-size:13px;letter-spacing:.08em', 'data-testid': 'conn-status' }, status.el),
      ),
      h(
        'div',
        { class: 'menu-right' },
        h('div', { class: 'menu-hero' }, h('div', { class: 'stripe', style: 'top:38%;left:0;width:60%' }), h('div', { class: 'stripe', style: 'top:41%;left:10%;width:40%;animation-delay:1.2s' })),
        h(
          'div',
          { class: 'menu-stage-card' },
          h('div', { class: 'label' }, `${STAGE_DEFS.length} STAGES · ${WEATHER[settings.get().rally.weather].name.toUpperCase()}`),
          h('h3', {}, stage.def.name),
          h('div', { class: 'meta' }, `${stage.def.location} · ${stage.def.surface} · ${((stage.finishDistance - stage.startDistance) / 1000).toFixed(2)} km`, h('br'), `${stage.def.description}`),
          preview.canvas,
        ),
      ),
    ),
  );
  raf = requestAnimationFrame(draw);
  // draw once a second is plenty for a static preview
  const stopper = setTimeout(() => cancelAnimationFrame(raf), 1500);
  return { el, dispose: () => { status.dispose(); cancelAnimationFrame(raf); clearTimeout(stopper); } };
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
  const leaveBtn = h('button', { class: 'btn danger' }, 'Close rally');
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
  const aiRow = h('div', { class: 'chip-row' });
  const aiBtns: HTMLElement[] = [];
  for (let n = 0; n <= MAX_AI; n++) {
    const b = h('button', { class: 'chip-btn', 'data-testid': `ai-${n}` }, n === 0 ? 'None' : `${n} AI`);
    b.onclick = () => choose({ aiCount: n });
    aiBtns.push(b);
    aiRow.append(b);
  }
  const skillRow = h('div', { class: 'chip-row' });
  const skillBtns = new Map<string, HTMLElement>();
  for (const sk of ['easy', 'medium', 'hard'] as const) {
    const b = h('button', { class: 'chip-btn' }, sk[0].toUpperCase() + sk.slice(1));
    b.onclick = () => choose({ aiSkill: sk });
    skillBtns.set(sk, b);
    skillRow.append(b);
  }

  const showConfig = (c: RallyConfig) => {
    bestEls.forEach((el, id) => {
      const b = career.best(bestKey(id, c.weather));
      el.textContent = b === null ? '' : `Best (${WEATHER[c.weather].name}): ${formatTime(b)}`;
    });
    current = { stageId: c.stageId, weather: c.weather, aiCount: c.aiCount, aiSkill: c.aiSkill };
    stageCards.forEach((el, id) => el.classList.toggle('sel', id === c.stageId));
    weatherBtns.forEach((el, id) => el.classList.toggle('sel', id === c.weather));
    aiBtns.forEach((el, n) => el.classList.toggle('sel', n === c.aiCount));
    skillBtns.forEach((el, id) => el.classList.toggle('sel', id === c.aiSkill));
    skillRow.style.opacity = c.aiCount ? '1' : '0.35';
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

  const render = (room: RoomSnapshot) => {
    codeEl.textContent = room.code;
    const url = `${location.origin}${location.pathname}#/join/${room.code}`;
    hint.innerHTML = '';
    hint.append(
      'On the navigator\'s tablet or phone, open ',
      h('code', {}, url),
      ' or choose ',
      h('b', {}, 'JOIN RALLY'),
      ' and enter the code above.',
    );
    if (net.mode === 'p2p' && /^(localhost|127\.0\.0\.1)$/.test(location.hostname)) {
      hint.append(h('br'), h('br'), 'This page is only on this computer. Open a second browser window here to test, or put the game online (see README).');
    }
    players.innerHTML = '';
    const row = (role: string, name: string, state: string, cls: string) =>
      h('div', { class: 'player-row' }, h('span', { class: `status-dot ${cls}` }), h('div', {}, h('div', { class: 'role' }, role), h('div', { class: 'name' }, name)), h('div', { class: 'state', 'data-testid': `${role.toLowerCase()}-state` }, state));
    const d = room.driver;
    players.append(row('DRIVER', d?.name ?? '—', d?.connected ? 'Connected' : 'Disconnected', d?.connected ? 'ok' : 'bad'));
    const n = room.navigator;
    players.append(
      n
        ? row('NAVIGATOR', n.name, n.connected ? 'Connected' : 'Reconnecting…', n.connected ? 'ok' : 'warn')
        : row('NAVIGATOR', 'Waiting for navigator…', 'Not connected', ''),
    );
    showConfig(room.race);
    startBtn.disabled = false;
    startBtn.textContent = solo ? 'Start stage' : n?.connected ? 'Start stage' : 'Start without navigator';
    if (room.race.phase === 'countdown' || room.race.phase === 'racing') nav.go('drive');
  };

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
      if (s.phase === 'countdown' || s.phase === 'racing') nav.go('drive');
    }),
    net.on('closed', (p) => { toast(p.reason, 'bad'); nav.go('menu'); }),
  );

  (async () => {
    try {
      if (net.session?.role === 'driver' && net.room) render(net.room);
      else render((await net.createRoom(playerName('Driver'), current)).room);
    } catch (e) {
      hint.textContent = (e as NetError).message;
      toast((e as NetError).message, 'bad');
    }
  })();

  const el = h(
    'div',
    { class: 'screen' },
    h('div', { class: 'screen-header' }, h('button', { class: 'back-btn', onclick: () => leaveBtn.click() }, '← Back'), h('h2', {}, solo ? 'Solo stage' : 'Rally lobby'), h('div', { style: 'margin-left:auto;color:var(--muted);font-size:13px' }, status.el)),
    h(
      'div',
      { class: 'lobby-wrap' },
      solo
        ? h('div', { class: 'panel', style: 'width:min(1100px,100%);display:flex;align-items:center;gap:16px;flex-wrap:wrap' },
            h('div', { style: 'flex:1;min-width:220px' }, h('div', { class: 'panel-title' }, 'Solo'), h('div', { class: 'setup-desc', style: 'margin:0' }, `Driving the ${career.activeDef().name}. Pick a stage, weather and AI opponents, then go. Every finish earns prize money.`)),
            startBtn,
          )
        : h(
        'div',
        { class: 'lobby' },
        h('div', { class: 'panel' }, h('div', { class: 'panel-title' }, 'Room code'), codeEl, hint),
        h(
          'div',
          { class: 'panel' },
          h('div', { class: 'panel-title' }, 'Crew'),
          players,
          h('div', { style: 'display:flex;gap:10px;margin-top:18px;flex-wrap:wrap' }, startBtn, leaveBtn),
        ),
      ),
      h(
        'div',
        { class: 'panel setup' },
        h('div', { class: 'panel-title' }, 'Stage'),
        stageGrid,
        h('div', { class: 'setup-cols' },
          h('div', {}, h('div', { class: 'panel-title' }, 'Weather'), weatherRow, weatherDesc),
          h('div', {}, h('div', { class: 'panel-title' }, 'AI opponents'), aiRow, h('div', { style: 'height:8px' }), skillRow),
        ),
      ),
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
  return `Today: ${getStage(ch.stageId)?.def.name} in ${WEATHER[ch.weather].name.toLowerCase()}, same loan car for everyone. Medals pay up to $12,000${done}.`;
}
export function playScreen(nav: Nav): Screen {
  const card = (k: string, title: string, desc: string, route: string, primary = false, id = '') =>
    h('button', { class: `play-card ${primary ? 'primary' : ''}`, onclick: () => nav.go(route), 'data-testid': id }, h('div', { class: 'k' }, k), h('div', { class: 't' }, title), h('div', { class: 'd' }, desc));
  const el = h(
    'div',
    { class: 'screen' },
    h('div', { class: 'screen-header' }, h('button', { class: 'back-btn', onclick: () => nav.go('menu') }, '← Menu'), h('h2', {}, 'Play'), h('div', { style: 'margin-left:auto' }, h('span', { class: 'money-chip' }, money(career.get().money)))),
    h(
      'div',
      { class: 'center-wrap play-wrap' },
      h('div', { class: 'play-row-title' }, 'Solo'),
      h(
        'div',
        { class: 'play-grid' },
        card('SOLO', 'Championship', champSub(), 'championship', true, 'play-championship'),
        card('SOLO', 'Daily challenge', dailySub(), 'daily', false, 'play-daily'),
        card('SOLO', 'Quick stage', 'Any stage, any weather, up to 3 AI rivals. Prize money for every finish.', 'solo', false, 'play-solo'),
      ),
      h('div', { class: 'play-row-title' }, 'Multiplayer'),
      h(
        'div',
        { class: 'play-grid two' },
        card('MULTIPLAYER', 'Create lobby', 'Host a rally and share the 4-character code. Your navigator joins from a tablet or phone.', 'create', false, 'play-create'),
        card('MULTIPLAYER', 'Join lobby', 'Enter a code to join a rally as the navigator. You earn a 40% share of your driver\'s prize.', 'join', false, 'play-join'),
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
  const name = h('input', { class: 'input', maxlength: 16, placeholder: 'Navigator', 'data-testid': 'join-name' }) as HTMLInputElement;
  name.value = settings.get().playerName;
  const error = h('div', { class: 'error-text', 'data-testid': 'join-error' }, '');
  const joinBtn = h('button', { class: 'btn primary big', style: 'width:100%', 'data-testid': 'join-btn' }, 'Join as navigator') as HTMLButtonElement;
  code.addEventListener('input', () => {
    code.value = code.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
    error.textContent = '';
  });
  const submit = async () => {
    error.textContent = '';
    if (code.value.length !== ROOM_CODE_LENGTH) {
      error.textContent = 'Enter the 4-character code shown on the driver\'s screen.';
      return;
    }
    joinBtn.disabled = true;
    try {
      if (name.value.trim()) settings.update({ playerName: name.value.trim() });
      await net.joinRoom(code.value, name.value.trim() || 'Navigator');
      nav.go('navigator');
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
    h('div', { class: 'screen-header' }, h('button', { class: 'back-btn', onclick: () => nav.go('menu') }, '← Menu'), h('h2', {}, 'Join rally'), h('div', { style: 'margin-left:auto;color:var(--muted);font-size:13px' }, status.el)),
    h(
      'div',
      { class: 'center-wrap' },
      h(
        'div',
        { class: 'panel', style: 'width:min(520px,100%)' },
        h('div', { class: 'panel-title' }, 'Navigator · Room code'),
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
  const row = (title: string, desc: string, control: HTMLElement) =>
    h('div', { class: 'setting-row' }, h('div', {}, h('div', { style: 'font-weight:700' }, title), h('div', { class: 'desc' }, desc)), control);

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
    h('div', { class: 'screen-header' }, h('button', { class: 'back-btn', onclick: () => nav.go('menu') }, '← Back'), h('h2', {}, 'Settings')),
    h(
      'div',
      { class: 'center-wrap', style: 'align-items:flex-start' },
      h(
        'div',
        { class: 'panel settings' },
        row('Player name', 'Shown to your crew-mate', name),
        row('Audio', 'Engine, gravel, effects and chimes', seg('audioEnabled', [[true, 'On'], [false, 'Off']])),
        row('Volume', 'Master volume', vol),
        row('Driver visibility', 'Night fog on the stage. Very low = you must trust your co-driver', seg('visibility', [['verylow', 'Very low'], ['low', 'Low'], ['normal', 'Normal']])),
        row('Wipers (start)', 'Wiper speed – change while driving with E', seg('wipers', [[0, 'Off'], [1, 'Slow'], [2, 'Fast']])),
        row('Graphics quality', 'Low: no shadows, fewer trees – for older laptops', seg('quality', [['high', 'High'], ['low', 'Low']])),
        row('Speed units', '', seg('units', [['kmh', 'km/h'], ['mph', 'mph']])),
        row('Controls help', 'Show key hints on the driving HUD', seg('showHelp', [[true, 'Show'], [false, 'Hide']])),
        row('Career', `Bank ${money(career.get().money)} · ${Object.keys(career.get().owned).length} car(s). Resetting starts again with ${money(20000)} and the Kestrel R5.`, resetBtn),
        h(
          'div',
          { class: 'desc', style: 'margin-top:18px;line-height:1.8;color:var(--muted)' },
          'Driver: W/↑ throttle · S/↓ brake & reverse · A/D steer · Space handbrake · E wipers · L light pod · R reset · Esc pause', h('br'),
          'Gamepad: RT throttle · LT brake · left stick steer · A/B handbrake · RB wipers · Y light pod · X reset · Start pause', h('br'),
          'Navigator: ↑ look at the road · ↓ look at the tablet (or tap the button) · drag to look around · call the stage out loud',
        ),
      ),
    ),
  );
  return { el };
}
