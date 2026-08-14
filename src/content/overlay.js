// src/content/overlay.js
// Mounts the battle assistant panel as a fixed overlay on the page, with a
// collapse button (from the panel itself), a hide button, and a floating
// ⚡ button to bring it back.

const OVERLAY_ID = 'psa-overlay';
const REOPEN_ID = 'psa-reopen';
const SIZE_STORAGE_KEY = 'psa-panel-size';
const POS_STORAGE_KEY = 'psa-panel-pos';
const COMPACT_STORAGE_KEY = 'psa-panel-compact';
const RESIZE_MIN_W = 240;
const RESIZE_MAX_W = 800;
const RESIZE_MIN_H = 160;

// Keep the panel reachable while it's dragged: the upper clamp leaves at
// least a corner (~140px wide, ~60px tall) inside the viewport, and the
// lower clamp keeps a small margin from the edges.
function clampPos(x, y) {
  const vw = typeof window !== 'undefined' ? window.innerWidth : 800;
  const vh = typeof window !== 'undefined' ? window.innerHeight : 600;
  return {
    x: Math.min(Math.max(8, Math.round(x)), Math.max(8, vw - 140)),
    y: Math.min(Math.max(8, Math.round(y)), Math.max(8, vh - 60)),
  };
}

function readStoredPos(overlay) {
  const fromDataset = overlay.dataset.psaPos;
  if (fromDataset) return fromDataset;
  try {
    return (typeof localStorage !== 'undefined' ? localStorage.getItem(POS_STORAGE_KEY) : null) ?? '';
  } catch {
    return '';
  }
}

function readStoredSize(overlay) {
  const fromDataset = overlay.dataset.psaSize;
  if (fromDataset) return fromDataset;
  try {
    return (typeof localStorage !== 'undefined' ? localStorage.getItem(SIZE_STORAGE_KEY) : null) ?? '';
  } catch {
    return '';
  }
}

// Restore a previously dragged panel size onto the freshly re-rendered panel.
// The size lives on the overlay (survives re-renders) and in localStorage
// (survives page loads), so the panel stays exactly where the user left it.
function applyPanelSize(overlay) {
  const stored = readStoredSize(overlay);
  const panel = overlay.querySelector('.psa-panel');
  if (!stored || !panel) return;
  const [w, h] = stored.split('x').map(Number);
  if (!(w > 0) || !(h > 0)) return;
  panel.style.width = `${w}px`;
  panel.style.height = `${h}px`;
  panel.style.maxWidth = 'none';
  panel.classList.add('psa-sized');
}

// Restore a previously dragged panel position. The position lives on the
// overlay (survives re-renders) and in localStorage (survives page loads),
// so the panel stays exactly where the user left it.
function applyPanelPos(overlay) {
  const stored = readStoredPos(overlay);
  if (!stored) return;
  const [x, y] = stored.split(',').map(Number);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return;
  const { x: cx, y: cy } = clampPos(x, y);
  overlay.style.left = `${cx}px`;
  overlay.style.top = `${cy}px`;
  overlay.style.right = 'auto';
}

// Drag the panel by its header to move it anywhere on the page (clamped,
// persisted live to the overlay + localStorage). Double-click the header to
// snap it back to the default top-right spot. Header buttons (collapse, hide)
// never start a drag.
function wireDrag(overlay) {
  const header = overlay.querySelector('.psa-header');
  if (!header) return;
  header.addEventListener('mousedown', (ev) => {
    if (ev.button !== 0 || ev.target.closest('button, .psa-resize')) return;
    ev.preventDefault();
    const startX = ev.clientX;
    const startY = ev.clientY;
    const rect = overlay.getBoundingClientRect();
    const startLeft = rect.left;
    const startTop = rect.top;
    overlay.classList.add('psa-dragging');
    const onMove = (e) => {
      const { x, y } = clampPos(startLeft + (e.clientX - startX), startTop + (e.clientY - startY));
      overlay.style.left = `${x}px`;
      overlay.style.top = `${y}px`;
      overlay.style.right = 'auto';
      overlay.dataset.psaPos = `${x},${y}`;
    };
    const onUp = () => {
      overlay.classList.remove('psa-dragging');
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      try {
        localStorage.setItem(POS_STORAGE_KEY, overlay.dataset.psaPos ?? '');
      } catch {
        // storage may be unavailable — the overlay dataset still holds it
      }
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  });
  header.addEventListener('dblclick', (ev) => {
    if (ev.target.closest('button, .psa-resize')) return;
    ev.preventDefault();
    overlay.style.left = '';
    overlay.style.top = '';
    overlay.style.right = '';
    overlay.dataset.psaPos = '';
    try {
      localStorage.removeItem(POS_STORAGE_KEY);
    } catch {
      // ignore
    }
  });
}

// Wire the corner handle: drag to resize (clamped, persisted live to the
// overlay + localStorage), double-click to reset to the default size.
function wireResize(overlay) {
  const handle = overlay.querySelector('.psa-resize');
  const panel = overlay.querySelector('.psa-panel');
  if (!handle || !panel) return;
  handle.addEventListener('mousedown', (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    const startX = ev.clientX;
    const startY = ev.clientY;
    const startW = panel.offsetWidth;
    const startH = panel.offsetHeight;
    const maxH = Math.round(window.innerHeight * 0.9);
    const onMove = (e) => {
      const w = Math.min(RESIZE_MAX_W, Math.max(RESIZE_MIN_W, startW + (e.clientX - startX)));
      const h = Math.min(maxH, Math.max(RESIZE_MIN_H, startH + (e.clientY - startY)));
      panel.style.width = `${w}px`;
      panel.style.height = `${h}px`;
      panel.style.maxWidth = 'none';
      panel.classList.add('psa-sized');
      overlay.dataset.psaSize = `${w}x${h}`;
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      try {
        localStorage.setItem(SIZE_STORAGE_KEY, overlay.dataset.psaSize ?? '');
      } catch {
        // storage may be unavailable — the overlay dataset still holds it
      }
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  });
  handle.addEventListener('dblclick', (ev) => {
    ev.preventDefault();
    panel.style.width = '';
    panel.style.height = '';
    panel.style.maxWidth = '';
    panel.classList.remove('psa-sized');
    overlay.dataset.psaSize = '';
    try {
      localStorage.removeItem(SIZE_STORAGE_KEY);
    } catch {
      // ignore
    }
  });
}

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
  const overlay = ensureOverlay();
  overlay.style.display = 'none';
  const reopen = ensureReopenButton();
  reopen.style.display = '';
  // If the panel was dragged somewhere, the ⚡ bring-back button appears
  // where the panel was, not stuck at the default top-right corner.
  const stored = readStoredPos(overlay);
  if (stored) {
    const [x, y] = stored.split(',').map(Number);
    if (Number.isFinite(x) && Number.isFinite(y)) {
      const { x: cx, y: cy } = clampPos(x, y);
      reopen.style.left = `${cx}px`;
      reopen.style.top = `${cy}px`;
      reopen.style.right = 'auto';
    }
  }
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
  // Compact mode persists like size/position: live on the overlay (survives
  // re-renders) and in localStorage (survives page loads).
  let compact = overlay.dataset.psaCompact;
  if (compact == null) {
    try {
      compact = typeof localStorage !== 'undefined' ? localStorage.getItem(COMPACT_STORAGE_KEY) : null;
    } catch {
      compact = null;
    }
  }
  if (compact === '1') panel?.classList.add('psa-compact');
  applyPanelSize(overlay);
  applyPanelPos(overlay);
  const newBody = overlay.querySelector('.psa-body');
  if (newBody) newBody.scrollTop = scrollTop;
  wireResize(overlay);
  wireDrag(overlay);

  // Compact toggle: reasoning + matchup each collapse to one line.
  const compactBtn = overlay.querySelector('.psa-compact');
  compactBtn?.addEventListener('click', () => {
    const on = !!panel?.classList.toggle('psa-compact');
    overlay.dataset.psaCompact = on ? '1' : '0';
    try {
      localStorage.setItem(COMPACT_STORAGE_KEY, on ? '1' : '0');
    } catch {
      // storage may be unavailable — the overlay dataset still holds it
    }
  });

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
