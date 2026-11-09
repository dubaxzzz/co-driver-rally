import * as THREE from 'three';
import { MAX_UPGRADE_LEVEL, PAINTS, UPGRADES, VEHICLES, WHEELS, applyUpgrades, vehicleById, type VehicleDef } from '@cdr/shared';
import { career, money } from '../career';
import { garageStore } from '../settings';
import { createCarModel, type CarModel } from '../game/vehicle/CarModel';
import { h, toast } from './dom';

type Tab = 'cars' | 'dealer' | 'upgrades' | 'paint';

/** Garage: your cars, the dealership, upgrades and paint – with a rotating 3D preview. */
export function garageScreen(back: () => void): { el: HTMLElement; dispose: () => void } {
  let tab: Tab = 'cars';
  let previewId = career.get().active;

  // ---- 3D preview ----
  const preview = h('div', { class: 'garage-preview' });
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(2, window.devicePixelRatio));
  renderer.shadowMap.enabled = true;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  preview.append(renderer.domElement);
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(35, 1, 0.1, 100);
  camera.position.set(6.8, 2.7, 6.8);
  camera.lookAt(0, 0.3, 0);
  scene.add(new THREE.HemisphereLight(0xffffff, 0x222222, 1.1));
  const key = new THREE.DirectionalLight(0xffffff, 2.5);
  key.position.set(5, 8, 4);
  key.castShadow = true;
  scene.add(key);
  const rim = new THREE.DirectionalLight(0xff6a3a, 1.4);
  rim.position.set(-6, 3, -5);
  scene.add(rim);
  const floor = new THREE.Mesh(new THREE.CircleGeometry(5, 48), new THREE.MeshStandardMaterial({ color: 0x15181c, roughness: 0.6, metalness: 0.2 }));
  floor.rotation.x = -Math.PI / 2;
  floor.position.y = -0.47;
  floor.receiveShadow = true;
  scene.add(floor);
  const ring = new THREE.Mesh(new THREE.RingGeometry(4.6, 4.75, 64), new THREE.MeshBasicMaterial({ color: 0xff4b1f }));
  ring.rotation.x = -Math.PI / 2;
  ring.position.y = -0.46;
  scene.add(ring);
  let car: CarModel | null = null;
  const showCar = (def: VehicleDef) => {
    if (car) {
      scene.remove(car.root);
      car.dispose();
    }
    const sel = garageStore.resolve();
    car = createCarModel(sel.paint, sel.wheel, def.body);
    car.wheels.forEach((w) => (w.position.y = -0.12 - 0.22));
    car.root.traverse((o) => ((o as THREE.Mesh).castShadow = true));
    scene.add(car.root);
  };

  let raf = 0;
  const loop = (t: number) => {
    raf = requestAnimationFrame(loop);
    const w = preview.clientWidth, hh = preview.clientHeight;
    if (renderer.domElement.width !== Math.round(w * renderer.getPixelRatio())) {
      renderer.setSize(w, hh, false);
      camera.aspect = w / Math.max(1, hh);
      camera.updateProjectionMatrix();
    }
    if (car) car.root.rotation.y = t * 0.0004;
    renderer.render(scene, camera);
  };
  raf = requestAnimationFrame(loop);

  // ---- side panel ----
  const moneyEl = h('div', { class: 'money-chip garage-money', 'data-testid': 'money' });
  const tabsEl = h('div', { class: 'seg garage-tabs' });
  const body = h('div', { class: 'garage-body' });
  const tabs: Array<[Tab, string]> = [['cars', 'My cars'], ['dealer', 'Dealership'], ['upgrades', 'Upgrades'], ['paint', 'Paint & wheels']];
  for (const [id, label] of tabs) {
    const b = h('button', { 'data-testid': `tab-${id}` }, label);
    b.onclick = () => {
      tab = id;
      if (id === 'cars' || id === 'upgrades' || id === 'paint') previewId = career.get().active;
      render();
    };
    tabsEl.append(b);
  }

  const statBlock = (def: VehicleDef, upgraded?: VehicleDef) => {
    const u = upgraded ?? def;
    const bar = (label: string, base: number, now: number) =>
      h(
        'div',
        { class: 'stat' },
        h('div', { class: 'row' }, h('span', {}, label)),
        h('div', { class: 'bar' }, h('i', { style: `width:${Math.min(100, base * 10)}%` }), now > base ? h('b', { style: `left:${base * 10}%;width:${Math.min(100 - base * 10, (now - base) * 10)}%` }) : null),
      );
    const power = def.stats.power * (u.enginePowerN / def.enginePowerN);
    const handling = def.stats.handling * Math.min(1.3, u.grip / def.grip);
    const braking = def.stats.braking * (u.brakeForce / def.brakeForce);
    return h(
      'div',
      {},
      h('div', { class: 'car-tags' }, h('span', {}, def.drive), h('span', {}, `${def.massKg} kg`), h('span', {}, `Armour ${Math.round(u.armour * 100)}%`)),
      bar('Power', def.stats.power, power),
      bar('Handling', def.stats.handling, handling),
      bar('Braking', def.stats.braking, braking),
      bar('Light weight', def.stats.weight, def.stats.weight),
    );
  };

  const carCard = (def: VehicleDef, actions: HTMLElement[], selected: boolean) => {
    const card = h(
      'div',
      { class: `car-card ${selected ? 'sel' : ''}`, 'data-testid': `car-${def.id}` },
      h('div', { class: 'car-head' }, h('div', {}, h('div', { class: 'car-name' }, def.name), h('div', { class: 'car-class' }, def.class)), def.price && !career.owns(def.id) ? h('div', { class: 'money-chip' }, money(def.price)) : null),
      h('div', { class: 'car-desc' }, def.description),
      h('div', { class: 'car-actions' }, ...actions),
    );
    card.onclick = (e) => {
      if ((e.target as HTMLElement).tagName === 'BUTTON') return;
      previewId = def.id;
      render();
    };
    return card;
  };

  const render = () => {
    const save = career.get();
    moneyEl.textContent = money(save.money);
    tabsEl.querySelectorAll('button').forEach((b, i) => b.classList.toggle('sel', tabs[i][0] === tab));
    body.innerHTML = '';
    const def = vehicleById(previewId);
    showCar(def);

    if (tab === 'cars') {
      body.append(h('div', { class: 'panel-title' }, 'Your cars'));
      for (const v of VEHICLES.filter((c) => career.owns(c.id))) {
        const active = save.active === v.id;
        const drive = h('button', { class: `btn ${active ? 'primary' : ''}`, disabled: active }, active ? 'Driving' : 'Drive this car');
        drive.onclick = () => {
          career.setActive(v.id);
          previewId = v.id;
          toast(`${v.name} selected`, 'ok');
          render();
        };
        body.append(carCard(v, [drive], previewId === v.id));
      }
      body.append(h('div', { class: 'panel-title', style: 'margin-top:18px' }, `${def.name} – stats`), statBlock(def, applyUpgrades(def, career.upgrades(def.id))));
      body.append(h('div', { class: 'setup-desc' }, `Stages driven: ${save.stats.stages} · Wins: ${save.stats.wins} · Total earned: ${money(save.stats.earned)}`));
    } else if (tab === 'dealer') {
      body.append(h('div', { class: 'panel-title' }, 'Dealership'));
      for (const v of VEHICLES) {
        const owned = career.owns(v.id);
        const buy = h('button', { class: 'btn primary', disabled: owned || save.money < v.price, 'data-testid': `buy-${v.id}` }, owned ? 'Owned' : save.money < v.price ? `Need ${money(v.price - save.money)}` : `Buy ${money(v.price)}`);
        buy.onclick = () => {
          const r = career.buyCar(v.id);
          if (r.ok) toast(`You bought the ${v.name}! It's now your car.`, 'ok');
          else toast(r.reason, 'bad');
          previewId = v.id;
          render();
        };
        body.append(carCard(v, [buy], previewId === v.id));
      }
      body.append(h('div', { class: 'panel-title', style: 'margin-top:18px' }, `${def.name} – stats`), statBlock(def));
    } else if (tab === 'upgrades') {
      const active = vehicleById(save.active);
      const lv = career.upgrades(active.id);
      body.append(h('div', { class: 'panel-title' }, `Upgrades – ${active.name}`));
      for (const u of UPGRADES) {
        const level = lv[u.kind];
        const cost = career.nextUpgradeCost(active.id, u.kind);
        const pips = h('div', { class: 'pips' });
        for (let i = 0; i < MAX_UPGRADE_LEVEL; i++) pips.append(h('i', { class: i < level ? 'on' : '' }));
        const buy = h('button', { class: 'btn primary', disabled: cost === null || save.money < cost, 'data-testid': `up-${u.kind}` }, cost === null ? 'Maxed' : `Level ${level + 1} · ${money(cost)}`);
        buy.onclick = () => {
          const r = career.buyUpgrade(active.id, u.kind);
          if (r.ok) toast(`${u.name} upgraded to level ${level + 1}`, 'ok');
          else toast(r.reason, 'bad');
          render();
        };
        body.append(h('div', { class: 'upgrade-row' }, h('div', {}, h('div', { class: 'car-name', style: 'font-size:16px' }, u.name), h('div', { class: 'car-desc' }, u.effect), pips), buy));
      }
      body.append(h('div', { class: 'panel-title', style: 'margin-top:18px' }, 'Stats with upgrades'), statBlock(active, applyUpgrades(active, lv)));
    } else {
      const sel = garageStore.resolve();
      const swatches = h('div', { class: 'swatches' });
      PAINTS.forEach((p) => {
        const s = h('button', { class: `swatch ${p.id === sel.paint.id ? 'sel' : ''}`, title: p.name });
        s.style.background = `linear-gradient(135deg, #${p.body.toString(16).padStart(6, '0')} 60%, #${p.accent.toString(16).padStart(6, '0')} 60%)`;
        s.onclick = () => {
          garageStore.update({ paintId: p.id });
          render();
        };
        swatches.append(s);
      });
      const wheelList = h('div', { class: 'option-list' });
      WHEELS.forEach((w) => {
        const b = h('button', { class: `option ${w.id === sel.wheel.id ? 'sel' : ''}` }, w.name + (w.gripMultiplier !== 1 ? ` (grip ${w.gripMultiplier > 1 ? '+' : ''}${Math.round((w.gripMultiplier - 1) * 100)}%)` : ''));
        b.onclick = () => {
          garageStore.update({ wheelId: w.id });
          render();
        };
        wheelList.append(b);
      });
      body.append(h('div', { class: 'panel-title' }, 'Paint (free)'), swatches, h('div', { class: 'panel-title', style: 'margin-top:22px' }, 'Wheels (free)'), wheelList);
    }
  };
  render();
  const unsub = career.subscribe(() => (moneyEl.textContent = money(career.get().money)));

  const el = h(
    'div',
    { class: 'screen' },
    h('div', { class: 'screen-header' }, h('button', { class: 'back-btn', onclick: back }, '← Back'), h('h2', {}, 'Garage'), h('div', { style: 'margin-left:auto' }, moneyEl)),
    h('div', { class: 'garage' }, preview, h('div', { class: 'garage-side' }, tabsEl, body)),
  );
  return {
    el,
    dispose: () => {
      unsub();
      cancelAnimationFrame(raf);
      car?.dispose();
      renderer.dispose();
    },
  };
}
