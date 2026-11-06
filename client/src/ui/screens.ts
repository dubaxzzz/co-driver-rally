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
import { settings, type Settings } from '../settings';
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

  const quickPlay = async (btn: HTMLButtonElement) => {
    btn.disabled = true;
    try {
      await net.createRoom(playerName('Driver'), settings.get().rally);
      await net.startRace();
      nav.go('drive');
    } catch (e) {
      toast((e as NetError).message, 'bad');
    } finally {
      btn.disabled = false;
    }
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
        btn('Play', `${stage.def.name} · ${WEATHER[settings.get().rally.weather].name} – navigator can join any time`, (b) => void quickPlay(b), true, 0),
        btn('Create Rally', 'Host a room & wait for your navigator', () => nav.go('create'), false, 60),
        btn('Join Rally', 'Navigator · enter a 4-character code', () => nav.go('join'), false, 120),
        btn('Garage', 'Car, paint & wheels', () => nav.go('garage'), false, 180),
        btn('Settings', 'Audio, graphics, controls', () => nav.go('settings'), false, 240),
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
export function lobbyScreen(nav: Nav): Screen {
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
    startBtn.textContent = n?.connected ? 'Start stage' : 'Start without navigator';
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
    h('div', { class: 'screen-header' }, h('button', { class: 'back-btn', onclick: () => leaveBtn.click() }, '← Menu'), h('h2', {}, 'Rally lobby'), h('div', { style: 'margin-left:auto;color:var(--muted);font-size:13px' }, status.el)),
    h(
      'div',
      { class: 'lobby-wrap' },
      h(
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
