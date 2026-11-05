import { DEFAULT_STAGE_ID, ROOM_CODE_LENGTH, getStage, type RoomSnapshot } from '@cdr/shared';
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
  const stage = getStage(DEFAULT_STAGE_ID)!;
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
      await net.createRoom(playerName('Driver'));
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
        btn('Play', 'Quick stage – navigator can join any time', (b) => void quickPlay(b), true, 0),
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
          h('div', { class: 'label' }, 'STAGE 1'),
          h('h3', {}, stage.def.name),
          h('div', { class: 'meta' }, `${stage.def.location} · ${stage.def.surface} · ${((stage.finishDistance - stage.startDistance) / 1000).toFixed(2)} km`, h('br'), `${stage.paceNotes.length} pace notes · ${stage.checkpoints.length} checkpoints`),
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
      hint.append(
        h('br'),
        h('br'),
        'This page is only on this computer. To test, open a second browser window here. ',
        'For a real tablet, upload the play folder to a free host such as Netlify Drop (see README) and open that link on both devices.',
      );
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
    net.on('race', (s) => { if (s.phase === 'countdown' || s.phase === 'racing') nav.go('drive'); }),
    net.on('closed', (p) => { toast(p.reason, 'bad'); nav.go('menu'); }),
  );

  (async () => {
    try {
      if (net.session?.role === 'driver' && net.room) render(net.room);
      else render((await net.createRoom(playerName('Driver'))).room);
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
      { class: 'center-wrap' },
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
    ),
  );
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
        row('Voice calls', 'Read pace notes aloud (speech synthesis)', seg('voiceCalls', [[true, 'On'], [false, 'Off']])),
        row('Automatic pace notes', 'Driver HUD calls corners automatically', seg('autoNotes', [['always', 'Always'], ['solo', 'Solo only'], ['off', 'Off']])),
        row('Graphics quality', 'Low: no shadows, fewer trees – for older laptops', seg('quality', [['high', 'High'], ['low', 'Low']])),
        row('Speed units', '', seg('units', [['kmh', 'km/h'], ['mph', 'mph']])),
        row('Controls help', 'Show key hints on the driving HUD', seg('showHelp', [[true, 'Show'], [false, 'Hide']])),
        h(
          'div',
          { class: 'desc', style: 'margin-top:18px;line-height:1.8;color:var(--muted)' },
          'Keyboard: W/↑ throttle · S/↓ brake & reverse · A/D steer · Space handbrake · C camera · R reset · Esc pause', h('br'),
          'Gamepad: RT throttle · LT brake · left stick steer · A/B handbrake · Y camera · X reset · Start pause',
        ),
      ),
    ),
  );
  return { el };
}
