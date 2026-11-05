import * as THREE from 'three';
import { PAINTS, VEHICLES, WHEELS } from '@cdr/shared';
import { garageStore } from '../settings';
import { createCarModel } from '../game/vehicle/CarModel';
import { h } from './dom';

/** Garage: rotating 3D preview, vehicle/paint/wheel selection and stats. */
export function garageScreen(back: () => void): { el: HTMLElement; dispose: () => void } {
  const sel = garageStore.resolve();
  const preview = h('div', { class: 'garage-preview' });
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(2, window.devicePixelRatio));
  renderer.shadowMap.enabled = true;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  preview.append(renderer.domElement);
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(35, 1, 0.1, 100);
  camera.position.set(6.5, 2.6, 6.5);
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

  const car = createCarModel(sel.paint, sel.wheel);
  car.wheels.forEach((w) => (w.position.y = -0.12 - 0.22));
  scene.add(car.root);

  let raf = 0;
  const loop = (t: number) => {
    raf = requestAnimationFrame(loop);
    const w = preview.clientWidth, hh = preview.clientHeight;
    if (renderer.domElement.width !== Math.round(w * renderer.getPixelRatio())) {
      renderer.setSize(w, hh, false);
      camera.aspect = w / Math.max(1, hh);
      camera.updateProjectionMatrix();
    }
    car.root.rotation.y = t * 0.0004;
    renderer.render(scene, camera);
  };
  raf = requestAnimationFrame(loop);

  // --- side panel ---
  const statBars: Record<string, HTMLElement> = {};
  const stat = (label: string, k: string) => {
    statBars[k] = h('i', {});
    return h('div', { class: 'stat' }, h('div', { class: 'row' }, h('span', {}, label)), h('div', { class: 'bar' }, statBars[k]));
  };
  const nameEl = h('h3', { style: 'margin:0;font-size:28px;font-style:italic;text-transform:uppercase' }, sel.vehicle.name);
  const classEl = h('div', { style: 'color:var(--accent);font-weight:800;letter-spacing:.16em;font-size:12px;margin:4px 0 8px' }, sel.vehicle.class);
  const descEl = h('div', { style: 'color:var(--muted);font-size:14px;line-height:1.5;margin-bottom:18px' }, sel.vehicle.description);
  const updateStats = () => {
    const v = garageStore.resolve();
    nameEl.textContent = v.vehicle.name;
    classEl.textContent = v.vehicle.class;
    descEl.textContent = v.vehicle.description;
    const grip = Math.round(v.vehicle.stats.handling * v.wheel.gripMultiplier * 10) / 10;
    statBars.power.style.width = `${v.vehicle.stats.power * 10}%`;
    statBars.handling.style.width = `${Math.min(100, grip * 10)}%`;
    statBars.braking.style.width = `${v.vehicle.stats.braking * 10}%`;
    statBars.weight.style.width = `${v.vehicle.stats.weight * 10}%`;
  };

  const vehicleList = h('div', { class: 'option-list' });
  VEHICLES.forEach((v) => {
    const b = h('button', { class: `option ${v.id === sel.vehicle.id ? 'sel' : ''}` }, `${v.name} · ${v.class}`);
    b.onclick = () => {
      garageStore.update({ vehicleId: v.id });
      vehicleList.querySelectorAll('.option').forEach((o) => o.classList.remove('sel'));
      b.classList.add('sel');
      updateStats();
    };
    vehicleList.append(b);
  });

  const swatches = h('div', { class: 'swatches' });
  PAINTS.forEach((p) => {
    const s = h('button', { class: `swatch ${p.id === sel.paint.id ? 'sel' : ''}`, title: p.name });
    s.style.background = `linear-gradient(135deg, #${p.body.toString(16).padStart(6, '0')} 60%, #${p.accent.toString(16).padStart(6, '0')} 60%)`;
    s.onclick = () => {
      garageStore.update({ paintId: p.id });
      car.setPaint(p);
      swatches.querySelectorAll('.swatch').forEach((o) => o.classList.remove('sel'));
      s.classList.add('sel');
      paintName.textContent = p.name;
    };
    swatches.append(s);
  });
  const paintName = h('div', { style: 'color:var(--muted);margin-top:8px;font-size:13px' }, sel.paint.name);

  const wheelList = h('div', { class: 'option-list' });
  WHEELS.forEach((w) => {
    const b = h('button', { class: `option ${w.id === sel.wheel.id ? 'sel' : ''}` }, w.name + (w.gripMultiplier !== 1 ? ` (grip ${w.gripMultiplier > 1 ? '+' : ''}${Math.round((w.gripMultiplier - 1) * 100)}%)` : ''));
    b.onclick = () => {
      garageStore.update({ wheelId: w.id });
      car.setWheels(w);
      wheelList.querySelectorAll('.option').forEach((o) => o.classList.remove('sel'));
      b.classList.add('sel');
      updateStats();
    };
    wheelList.append(b);
  });

  const side = h(
    'div',
    { class: 'garage-side' },
    nameEl,
    classEl,
    descEl,
    stat('Power', 'power'),
    stat('Handling', 'handling'),
    stat('Braking', 'braking'),
    stat('Weight', 'weight'),
    h('div', { class: 'panel-title', style: 'margin-top:22px' }, 'Vehicle'),
    vehicleList,
    h('div', { class: 'panel-title', style: 'margin-top:22px' }, 'Paint'),
    swatches,
    paintName,
    h('div', { class: 'panel-title', style: 'margin-top:22px' }, 'Wheels'),
    wheelList,
  );
  updateStats();

  const el = h(
    'div',
    { class: 'screen' },
    h('div', { class: 'screen-header' }, h('button', { class: 'back-btn', onclick: back }, '← Back'), h('h2', {}, 'Garage')),
    h('div', { class: 'garage' }, preview, side),
  );
  return {
    el,
    dispose: () => {
      cancelAnimationFrame(raf);
      car.dispose();
      renderer.dispose();
    },
  };
}
