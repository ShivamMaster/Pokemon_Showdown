// src/content/overlay.js
// Mounts the battle assistant panel as a fixed overlay on the page, with a
// collapse button (from the panel itself), a hide button, and a floating
// ⚡ button to bring it back.

const OVERLAY_ID = 'psa-overlay';
const REOPEN_ID = 'psa-reopen';

export function ensureOverlay() {
  let el = document.getElementById(OVERLAY_ID);
  if (!el) {
    el = document.createElement('div');
    el.id = OVERLAY_ID;
    el.className = 'psa-overlay';
    document.body.appendChild(el);
  }
  return el;
}

export function ensureReopenButton() {
  let btn = document.getElementById(REOPEN_ID);
  if (!btn) {
    btn = document.createElement('button');
    btn.id = REOPEN_ID;
    btn.type = 'button';
    btn.className = 'psa-reopen';
    btn.title = 'Show battle assistant';
    btn.textContent = '⚡';
    btn.style.display = 'none';
    btn.addEventListener('click', showPanel);
    document.body.appendChild(btn);
  }
  return btn;
}

export function showPanel() {
  ensureOverlay().style.display = '';
  ensureReopenButton().style.display = 'none';
}

export function hidePanel() {
  ensureOverlay().style.display = 'none';
  ensureReopenButton().style.display = '';
}

// Replace the panel contents and wire the header buttons. Returns the overlay.
export function mountPanel(html) {
  const overlay = ensureOverlay();
  overlay.innerHTML = html;

  const panel = overlay.querySelector('.psa-panel');
  const collapse = overlay.querySelector('.psa-collapse');
  collapse?.addEventListener('click', () => panel?.classList.toggle('psa-collapsed'));

  const header = panel?.querySelector('.psa-header');
  if (header && !header.querySelector('.psa-hide')) {
    const hide = document.createElement('button');
    hide.type = 'button';
    hide.className = 'psa-hide';
    hide.title = 'Hide assistant';
    hide.textContent = '×';
    hide.addEventListener('click', hidePanel);
    header.appendChild(hide);
  }

  return overlay;
}
