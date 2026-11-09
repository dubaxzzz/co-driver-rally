/** Tiny DOM helpers – no framework needed. */

type Attrs = Record<string, string | number | boolean | EventListener | undefined>;

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Attrs = {},
  ...children: Array<Node | string | null | undefined | false>
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') {
      el.addEventListener(k.slice(2).toLowerCase(), v as EventListener);
    } else if (k === 'class') {
      el.className = String(v);
    } else if (k === 'html') {
      el.innerHTML = String(v);
    } else if (v === true) {
      el.setAttribute(k, '');
    } else {
      el.setAttribute(k, String(v));
    }
  }
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    el.append(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return el;
}

export function toast(message: string, kind: 'info' | 'ok' | 'bad' = 'info', ms = 3200) {
  const host = document.getElementById('toasts');
  if (!host) return;
  const el = h('div', { class: `toast ${kind}` }, message);
  host.append(el);
  setTimeout(() => el.remove(), ms);
}

export function escapeHtml(s: string) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

export function loadingOverlay(text: string) {
  return h('div', { class: 'loading' }, h('div', { class: 'spinner' }), h('div', { class: 'panel-title' }, text));
}

/** The same header on every screen: back button, title, and an optional item on the right. */
export function screenHeader(backLabel: string, onBack: () => void, title: string, right?: Node | null) {
  return h(
    'header',
    { class: 'screen-header' },
    h('button', { class: 'back-btn', onclick: () => onBack(), 'aria-label': backLabel, 'data-testid': 'back-btn' }, h('span', { class: 'back-ico' }, '‹'), h('span', { class: 'back-txt' }, backLabel)),
    h('h2', {}, title),
    h('div', { class: 'screen-header-right' }, right ?? null),
  );
}
