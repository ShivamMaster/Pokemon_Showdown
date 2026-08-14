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
//
// The panel re-renders on every poll tick and capture frame, so we carry over
// the user's scroll position, collapsed state, and any open damage-calc view —
// otherwise it snaps back to the top, pops open, and collapses the calc on
// every render.
export function mountPanel(html) {
  const overlay = ensureOverlay();
  const oldBody = overlay.querySelector('.psa-body');
  const scrollTop = oldBody?.scrollTop ?? 0;
  const wasCollapsed = !!overlay.querySelector('.psa-panel')?.classList.contains('psa-collapsed');
  const wasCalcOpen = overlay.dataset.psaCalcOpen === '1';

  overlay.innerHTML = html;

  const panel = overlay.querySelector('.psa-panel');
  if (wasCollapsed) panel?.classList.add('psa-collapsed');
  const newBody = overlay.querySelector('.psa-body');
  if (newBody) newBody.scrollTop = scrollTop;

  // Re-open the full damage calc if it was open before this re-render.
  const matchup = overlay.querySelector('.psa-matchup');
  if (wasCalcOpen) matchup?.classList.add('psa-calc-open');

  // Clicking a Damage bar toggles the full damage calc for that matchup.
  // The open state lives on the overlay so it survives re-renders.
  for (const btn of overlay.querySelectorAll('.psa-bar-btn')) {
    btn.addEventListener('click', (ev) => {
      ev.preventDefault();
      const m = btn.closest('.psa-matchup');
      if (!m) return;
      const open = m.classList.toggle('psa-calc-open');
      overlay.dataset.psaCalcOpen = open ? '1' : '0';
    });
  }

  // Clicking a dashed hidden-threat segment reveals which move it represents
  // (a name badge over the segment). Revealed keys survive re-renders via
  // overlay.dataset.psaPotReveals.
  const revealedPots = new Set((overlay.dataset.psaPotReveals ?? '').split(',').filter(Boolean));
  for (const pot of overlay.querySelectorAll('.psa-mini-pot')) {
    if (revealedPots.has(pot.dataset.potKey)) pot.classList.add('psa-pot-revealed');
    pot.addEventListener('click', (ev) => {
      ev.preventDefault();
      pot.classList.toggle('psa-pot-revealed');
      const key = pot.dataset.potKey;
      const set = new Set((overlay.dataset.psaPotReveals ?? '').split(',').filter(Boolean));
      if (pot.classList.contains('psa-pot-revealed')) set.add(key);
      else set.delete(key);
      overlay.dataset.psaPotReveals = [...set].filter(Boolean).join(',');
    });
  }

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
