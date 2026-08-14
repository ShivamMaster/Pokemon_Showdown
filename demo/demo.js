// demo/demo.js — wires the reader + engine + panel into the demo page.
import { BattleReader } from '../src/reader/index.js';
import { buildPanelModel, renderPanel } from '../src/ui/panel.js';
import { recommend, applyObservations } from '../src/engine/index.js';
import { topPotentialMoves } from '../src/engine/movepool.js';

const textarea = document.getElementById('log-input');
const container = document.getElementById('panel-container');
const status = document.getElementById('status');
const sideSelect = document.getElementById('side');

function activeAlive(side) {
  return (
    (side?.active ?? [])
      .map((ident) => side.pokemon?.find((p) => p.ident === ident))
      .find((m) => m && !m.fainted) ?? null
  );
}

// Parse the whole log in one pass, keeping a snapshot at the last point where
// both sides had an alive active Pokémon — the closest thing to "it's my turn
// to choose". The engine gives advice for that moment instead of the final
// (usually already-decided) state.
function parseWithSnapshot(logText) {
  const reader = new BattleReader();
  let snapshot = null;
  for (const line of logText.split(/\r?\n/)) {
    const event = reader.applyLine(line);
    if (event?.type === 'turn') {
      const s = reader.state;
      if (activeAlive(s.sides.p1) && activeAlive(s.sides.p2)) {
        snapshot = structuredClone(s);
      }
    }
  }
  return { state: reader.state, snapshot };
}

function render() {
  const text = textarea.value;
  let state;
  let snapshot;
  try {
    ({ state, snapshot } = parseWithSnapshot(text));
  } catch (err) {
    status.textContent = `Parse error: ${err.message}`;
    container.innerHTML = '';
    return;
  }

  const ourSideId = sideSelect.value;
  const recState = snapshot ?? state;
  // Back-calculate EV investment from the damage seen in the log.
  applyObservations(recState);
  const recommendation = recommend(recState, { ourSideId });
  const model = buildPanelModel(recState, {
    ourSideId,
    recommendation,
    getPotentialMoves: (species) => topPotentialMoves(species, 3, recState.gen ?? 9),
  });
  container.innerHTML = renderPanel(model);

  const panel = container.querySelector('.psa-panel');
  panel.dataset.rendered = 'true';
  const collapse = panel.querySelector('.psa-collapse');
  collapse.addEventListener('click', () => panel.classList.toggle('psa-collapsed'));
  const compact = panel.querySelector('.psa-compact');
  compact.addEventListener('click', () => panel.classList.toggle('psa-compact'));

  const mons = state.sides.p1.pokemon.length + state.sides.p2.pokemon.length;
  const adviceFor = snapshot ? `turn ${snapshot.turn}` : 'final state';
  status.textContent =
    `Parsed: ${state.format ?? 'unknown format'} · ${mons} Pokémon · ` +
    `${state.actions.length} actions · advice for ${adviceFor}`;
  window.__lastModel = model;
  window.__lastRecommendation = recommendation; // inspect in the console
}

async function loadSample() {
  try {
    const res = await fetch('../test/fixtures/real-battle.log');
    if (!res.ok) throw new Error(`fetch failed (${res.status})`);
    textarea.value = await res.text();
    render();
  } catch (err) {
    status.textContent = `Could not load sample — serve this folder (e.g. python3 -m http.server) and retry. (${err.message})`;
  }
}

document.getElementById('render').addEventListener('click', render);
document.getElementById('load-sample').addEventListener('click', loadSample);
sideSelect.addEventListener('change', render);

loadSample();
