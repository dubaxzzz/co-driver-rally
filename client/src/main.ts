import './ui/styles.css';
import { net } from './multiplayer/NetClient';
import { h, loadingOverlay, toast } from './ui/dom';
import { joinScreen, lobbyScreen, menuScreen, settingsScreen, type Screen } from './ui/screens';
import './audio/AudioEngine';

/**
 * Hash router: #/ menu · #/create lobby · #/join/CODE · #/garage ·
 * #/settings · #/drive (driver game) · #/navigator (co-driver tablet).
 */
const app = document.getElementById('app')!;
let current: Screen | null = null;
let routeToken = 0;

function go(route: string) {
  const target = `#/${route === 'menu' ? '' : route}`;
  if (location.hash === target) void render();
  else location.hash = target;
}

async function render() {
  const token = ++routeToken;
  current?.dispose?.();
  current = null;
  app.innerHTML = '';
  const [route, param] = location.hash.replace(/^#\/?/, '').split('/');
  const nav = { go };

  switch (route) {
    case 'create':
      current = lobbyScreen(nav);
      break;
    case 'join':
      current = joinScreen(nav, param ?? '');
      break;
    case 'garage': {
      const { garageScreen } = await import('./ui/garage');
      if (token !== routeToken) return;
      const g = garageScreen(() => go('menu'));
      current = { el: g.el, dispose: g.dispose };
      break;
    }
    case 'settings':
      current = settingsScreen(nav);
      break;
    case 'drive': {
      if (net.session?.role !== 'driver') return go('menu');
      const root = h('div', { class: 'game-root' });
      app.append(root);
      // Load Three.js/Rapier only for the driver (keeps the navigator page light)
      const { Game } = await import('./game/Game');
      if (token !== routeToken) return;
      const game = new Game(root, (to) => go(to === 'lobby' ? 'create' : 'menu'));
      current = { el: root, dispose: () => game.dispose() };
      void game.init();
      return;
    }
    case 'navigator': {
      if (net.session?.role !== 'navigator') return go('join');
      const { NavigatorApp } = await import('./navigator/NavigatorApp');
      if (token !== routeToken) return;
      const navApp = new NavigatorApp(() => go('menu'), () => void render());
      current = { el: navApp.root, dispose: () => navApp.dispose() };
      break;
    }
    default:
      current = menuScreen(nav);
  }
  app.append(current.el);
}

window.addEventListener('hashchange', () => void render());

/** On page load, try to reclaim an existing seat (e.g. after a refresh). */
async function boot() {
  if (!net.session) return render();
  app.append(loadingOverlay('Reconnecting to your rally'));
  const result = await new Promise<'ok' | 'fail'>((resolve) => {
    const offA = net.on('resumed', () => { offA(); offB(); resolve('ok'); });
    const offB = net.on('resumeFailed', () => { offA(); offB(); resolve('fail'); });
    setTimeout(() => { offA(); offB(); resolve(net.session ? 'ok' : 'fail'); }, 8000);
  });
  if (result === 'fail' || !net.session) {
    toast('Your previous rally session has ended.', 'info');
    return go('menu');
  }
  const role = net.session.role;
  const phase = net.room?.race.phase;
  if (role === 'navigator') {
    go('navigator');
  } else {
    go(phase === 'countdown' || phase === 'racing' || phase === 'finished' ? 'drive' : 'create');
  }
}

void boot();
