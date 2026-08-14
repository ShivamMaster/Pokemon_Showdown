// src/ui/panel.js
// Pure UI layer for the battle assistant panel.
//
// buildPanelModel(state, opts) turns a reader BattleState into a plain display
// model. renderPanel(model) renders that model to an HTML string.
//
// No DOM access anywhere in this file, so it runs identically in Node (tests)
// and in the browser (extension content script + demo page). The engine will
// plug into the recommendation slot later via opts.recommendation.

import { Pokemon, Move } from '@smogon/calc';
import { buildField, buildPokemon, effectivenessOf } from '../engine/calc.js';
import { topPotentialMoves } from '../engine/movepool.js';
import { matchupDamage } from '../engine/recommend.js';
import { speedLine } from '../engine/speed.js';

const STATUS_LABELS = {
  brn: 'Burn',
  par: 'Paralysis',
  slp: 'Sleep',
  frz: 'Frozen',
  psn: 'Poison',
  tox: 'Toxic',
};

// Stat display: short labels and the display order.
const STAT_KEYS = ['atk', 'def', 'spa', 'spd', 'spe'];
const STAT_SHORT = { atk: 'A', def: 'D', spa: 'SA', spd: 'SD', spe: 'S' };

// Best-known range for one stat of a Pokémon, for the card's stats row:
//   1. exact value (our team's live request / our hover tooltip raw stats),
//   2. the opponent's hovered Spe range (authoritative EV/nature bounds),
//   3. the back-calculated EV estimate narrowing the calc range,
//   4. the plain 0→252 EV calc range (nothing revealed).
function statRangeOf(gen, mon, stat) {
  if (!mon?.species || !gen) return null;
  const level = mon.level ?? 100;
  if (mon.stats?.[stat] != null) return { min: mon.stats[stat], max: mon.stats[stat], exact: true };
  if (stat === 'spe' && mon.speedRange?.min != null && mon.speedRange?.max != null) {
    return { min: mon.speedRange.min, max: mon.speedRange.max, exact: false };
  }
  const ev = mon.evEstimate?.[stat];
  const evLo = ev ? ev[0] : 0;
  const evHi = ev ? ev[1] : 252;
  try {
    const min = new Pokemon(gen, mon.species, { level, evs: { [stat]: evLo }, nature: 'Serious' }).stats[stat];
    const max = new Pokemon(gen, mon.species, {
      level,
      evs: { [stat]: evHi },
      nature: stat === 'spe' ? 'Timid' : 'Serious',
    }).stats[stat];
    return { min, max, exact: false };
  } catch {
    return null;
  }
}

function statsOf(gen, mon) {
  const out = [];
  for (const s of STAT_KEYS) {
    const r = statRangeOf(gen, mon, s);
    if (!r) continue;
    out.push({
      key: STAT_SHORT[s],
      text: r.min === r.max ? String(r.min) : `${r.min}-${r.max}`,
      exact: r.exact,
      min: r.min,
      max: r.max,
    });
  }
  return out.length ? out : null;
}

export function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[c]));
}

// Types of a mon as they currently are on the field. The calc Pokemon resolves
// the species' types from its data; a terastallized mon shows only its tera
// type (the calc keeps base types in `.types` and applies tera during damage
// calcs, so we handle it here — same rule as the engine's worstThreat).
function fieldTypes(gen, mon) {
  if (!mon?.species) return null;
  if (mon.terastallized && mon.teraType) return [mon.teraType];
  try {
    return buildPokemon(gen, mon).types ?? null;
  } catch {
    return null;
  }
}

function moveTypeOf(gen, moveName) {
  try {
    return new Move(gen, moveName).type ?? null;
  } catch {
    return null;
  }
}

// Type-effectiveness summary for the active matchup: which of our moves hit
// their current types super effectively (2×+), and which of theirs — revealed
// or merely likely (top potential moves, marked separately) — could hit ours.
// Status moves and unresolvable moves are skipped.
export function typeEdgeOf(gen, ourMon, theirMon) {
  const edge = { ourSE: [], theirSE: [], theirPotentialSE: [], unknown: false };
  const ourTypes = fieldTypes(gen, ourMon);
  const theirTypes = fieldTypes(gen, theirMon);
  if (!ourTypes || !theirTypes) {
    edge.unknown = true;
    return edge;
  }
  const effVs = (defTypes) => (moveName) => {
    const t = moveTypeOf(gen, moveName);
    if (!t) return null;
    return effectivenessOf(gen, t, defTypes);
  };
  const push = (list, move, mult) => list.push({ move, mult });
  const ourEff = effVs(theirTypes);
  for (const m of ourMon?.moves ?? []) {
    const e = ourEff(m);
    if (e != null && e >= 2) push(edge.ourSE, m, e);
  }
  const theirEff = effVs(ourTypes);
  for (const m of theirMon?.moves ?? []) {
    const e = theirEff(m);
    if (e != null && e >= 2) push(edge.theirSE, m, e);
  }
  // Likely-but-unrevealed threats from their species' learnset.
  const revealed = new Set(theirMon?.moves ?? []);
  for (const m of topPotentialMoves(theirMon?.species, 8, gen) ?? []) {
    if (revealed.has(m)) continue;
    const e = theirEff(m);
    if (e != null && e >= 2) push(edge.theirPotentialSE, m, e);
  }
  const sort = (l) => l.sort((a, b) => b.mult - a.mult || a.move.localeCompare(b.move));
  sort(edge.ourSE);
  sort(edge.theirSE);
  sort(edge.theirPotentialSE);
  return edge;
}

// ---------------------------------------------------------------------------
// Display model
// ---------------------------------------------------------------------------

export function buildPanelModel(state, opts = {}) {
  const ourSideId = opts.ourSideId ?? 'p1';
  const ourSide = state?.sides?.[ourSideId] ?? null;
  const theirSide = ourSideId === 'p1' ? state?.sides?.p2 ?? null : state?.sides?.p1 ?? null;
  const gen = state?.gen ?? 9;
  const field = buildField(state);

  const empty = !(ourSide?.pokemon?.length || theirSide?.pokemon?.length);

  // The Pokémon currently on the field for a side (the engine's activeMon).
  const activeOf = (side) => {
    for (const ident of side?.active ?? []) {
      const mon = side?.pokemon?.find((p) => p.ident === ident);
      if (mon && !mon.fainted) return mon;
    }
    // Fallback for request-created records (the request sets mon.active
    // without touching side.active).
    return side?.pokemon?.find((p) => p.active && !p.fainted) ?? null;
  };
  const ourActiveMon = activeOf(ourSide);
  const theirActiveMon = activeOf(theirSide);

  const getPotential = opts.getPotentialMoves ?? null;

  // Learned EV investment (back-calculated from observed damage) as a short
  // label like "spa 252" / "def ~120", or null when nothing narrowed yet.
  const evLabelOf = (mon) => {
    const est = mon?.evEstimate;
    if (!est) return null;
    const parts = [];
    for (const stat of ['atk', 'spa', 'def', 'spd', 'hp']) {
      const r = est[stat];
      if (!r) continue;
      const width = r[1] - r[0];
      if (width > 48) continue;
      const val = Math.max(0, Math.min(252, Math.round((r[0] + r[1]) / 2 / 4) * 4));
      parts.push(`${stat} ${width <= 4 ? val : `~${val}`}`);
    }
    return parts.length ? parts.join(' · ') : null;
  };

  const cardOf = (mon, showPotential, vsActiveMon = null) => {
    const boosts = Object.fromEntries(Object.entries(mon.boosts ?? {}).filter(([, v]) => v !== 0));
    const hidden = Math.max(0, 4 - (mon.moves?.length ?? 0));
    const stats = statsOf(gen, mon);
    // Predicted-damage comparison vs their active, for switch candidates in
    // the You box. Same matchupDamage source as the matchup's Damage row, so
    // every number agrees everywhere. Only alive bench mons are candidates.
    let vsActive = null;
    if (vsActiveMon && !mon.fainted && !mon.active) {
      const d = matchupDamage(gen, mon, vsActiveMon, field);
      vsActive = {
        species: vsActiveMon.species,
        takes: d.theirs ?? null,
        deals: d.ours ?? null,
        hidden: d.theirHidden,
      };
    }
    return {
      ident: mon.ident,
      species: mon.species,
      nickname: mon.nickname,
      preview: !!mon.preview,
      active: !!mon.active,
      fainted: !!mon.fainted,
      hpPercent: mon.hpPercent ?? null,
      status: mon.status ?? null,
      item: mon.item ?? null,
      itemKnown: !!mon.itemRevealed,
      itemConsumed: !!mon.itemConsumed,
      ability: mon.ability ?? null,
      tera: mon.teraType ?? null,
      teraActive: !!mon.terastallized,
      canTera: mon.canTera ?? null,
      moves: [...(mon.moves ?? [])],
      movePp: { ...(mon.movePp ?? {}) },
      hiddenCount: hidden,
      observed: !!mon.observed,
      evLabel: evLabelOf(mon),
      stats,
      statsExact: !!(stats && stats.every((s) => s.exact)),
      boosts,
      switchCount: mon.switchCount ?? 0,
      potential:
        showPotential && hidden > 0 && getPotential ? (getPotential(mon.species) ?? []).slice(0, 3) : [],
      vsActive,
    };
  };

  // Team-preview card: we know the species (from |poke|) but nothing else yet.
  const previewOf = (entry, showPotential) =>
    cardOf(
      {
        ident: null,
        species: entry.species,
        nickname: null,
        preview: true,
        moves: [],
        movePp: {},
        item: null,
        itemRevealed: false,
        itemConsumed: false,
        ability: null,
        teraType: null,
        terastallized: false,
        canTera: null,
        active: false,
        fainted: false,
        hpPercent: null,
        status: null,
        observed: false,
        boosts: {},
        switchCount: 0,
      },
      showPotential
    );

  // Six slots per side (or the team size): team-preview order for the
  // opponent, request order for our team. Unknown slots stay as placeholders
  // and fill in as Pokémon are revealed.
  const sideModel = (side, { showPotential, vsActive } = {}) => {
    const roster = side?.roster ?? [];
    const pokemon = side?.pokemon ?? [];
    const order = roster.length ? roster.map((r) => r.species) : pokemon.map((p) => p.species);
    const real = Math.max(order.length, pokemon.length);
    const slotCount = real ? Math.max(side?.teamSize ?? 6, real) : 0;
    const used = new Set();
    const slots = [];
    for (let i = 0; i < slotCount; i++) {
      const wanted = order[i] ?? null;
      let mon = wanted ? pokemon.find((p) => p.species === wanted && !used.has(p.ident)) : null;
      if (!mon) mon = pokemon.find((p) => !used.has(p.ident)) ?? null;
      if (mon) used.add(mon.ident);
      if (mon) {
        slots.push(cardOf(mon, showPotential, vsActive));
      } else if (roster[i]?.species) {
        // Team preview: the species is known (|poke|) even though no battle
        // record exists yet — show it instead of a blank slot.
        slots.push(previewOf(roster[i], showPotential));
      } else {
        slots.push({ empty: true, slot: i + 1 });
      }
    }
    return {
      name: side?.playerName ?? null,
      slots,
      team: slots.filter((s) => !s.empty),
      sideEffects: Object.entries(side?.effects ?? {})
        .map(([name, count]) => (count > 1 ? `${name} ×${count}` : name))
        .sort(),
    };
  };

  // Active-matchup comparison: our lead vs their lead, side by side. Only
  // shown once both sides actually have a Pokémon on the field.
  let matchup = null;
  if (ourActiveMon && theirActiveMon) {
    matchup = {
      ours: cardOf(ourActiveMon, false),
      theirs: cardOf(theirActiveMon, false),
      speed: speedLine(ourActiveMon, theirActiveMon, gen, state, ourSideId),
      typeEdge: typeEdgeOf(gen, ourActiveMon, theirActiveMon),
      damage: matchupDamage(gen, ourActiveMon, theirActiveMon, field),
    };
  }

  const fieldParts = [];
  fieldParts.push(`weather: ${state?.field?.weather ?? 'none'}`);
  fieldParts.push(`terrain: ${state?.field?.terrain ?? 'none'}`);
  for (const [name, count] of Object.entries(state?.field?.effects ?? {})) {
    fieldParts.push(count > 1 ? `${name} ×${count}` : name);
  }

  const actionText = (a) => {
    switch (a.type) {
      case 'move':
        return `${a.ident} used ${a.move}`;
      case 'switch':
        return `${a.ident} → ${a.species}${a.forced ? ' (forced)' : ''}`;
      case 'faint':
        return `${a.ident} fainted`;
      case 'damage':
      case 'heal':
        return a.hpPercent != null ? `${a.ident} at ${a.hpPercent}%` : a.ident;
      default:
        return a.status ? `${a.ident} ${a.status}` : `${a.ident} ${a.type}`;
    }
  };

  return {
    empty,
    meta: {
      format: state?.format ?? null,
      gen: state?.gen ?? null,
      gametype: state?.gametype ?? null,
      turn: state?.turn ?? 0,
      winner: state?.winner ?? null,
      ourName: ourSide?.playerName ?? null,
      oppName: theirSide?.playerName ?? null,
    },
    field: fieldParts.join(' · '),
    matchup,
    us: sideModel(ourSide, { showPotential: false, vsActive: theirActiveMon }),
    them: sideModel(theirSide, { showPotential: true }),
    recommendation: opts.recommendation ?? null,
    profile: opts.profile ?? null,
    watching: { count: opts.watching?.count ?? 0, last: opts.watching?.last ?? null },
    ocrCount: opts.watching?.ocrCount ?? 0,
    capture: {
      active: !!opts.capture?.active,
      frames: opts.capture?.frames ?? 0,
      changes: opts.capture?.changes ?? 0,
    },
    recentActions: (state?.actions ?? [])
      .slice(-20)
      .reverse()
      .map((a) => ({ turn: a.turn, text: actionText(a) })),
  };
}

// ---------------------------------------------------------------------------
// HTML rendering
// ---------------------------------------------------------------------------

function hpBar(hpPercent) {
  if (hpPercent == null) {
    return '<div class="psa-hpbar"><div class="psa-hpfill psa-hp-unknown" style="width:100%"></div></div>';
  }
  const pct = Math.max(0, Math.min(100, hpPercent));
  const cls = pct <= 20 ? 'psa-hp-low' : pct <= 50 ? 'psa-hp-mid' : 'psa-hp-high';
  return `<div class="psa-hpbar"><div class="psa-hpfill ${cls}" style="width:${pct}%"></div></div>`;
}

function renderCard(card) {
  const boostsText = Object.entries(card.boosts)
    .map(([s, v]) => `${v > 0 ? '+' : ''}${v} ${s}`)
    .join(' · ');
  const itemText = card.itemKnown ? card.item + (card.itemConsumed ? ' (gone)' : '') : '?';
  let teraText = '';
  if (card.tera) {
    teraText = ` · tera: ${card.tera}${card.teraActive ? ' ✦ active' : card.canTera ? ' (can tera)' : ''}`;
  } else if (card.canTera) {
    teraText = ' · can tera';
  }
  const details = `item: ${itemText} · ability: ${card.ability ?? '?'}${teraText}`;
  const evHtml = card.evLabel
    ? `<div class="psa-ev" title="Back-calculated from observed damage">learned ev: ${escapeHtml(card.evLabel)}</div>`
    : '';
  // Stats row: exact numbers for our team (live request / hover), estimated
  // ranges for theirs — narrowed by the learned EV estimate and hovered Spe.
  const statsHtml = card.stats?.length
    ? `<div class="psa-stats" title="${card.statsExact ? 'Exact stats from your team data (live request / hover)' : 'Estimated stat ranges — they narrow as moves, items, and damage are revealed'}">${card.stats
        .map((s) => `<span class="psa-stat${s.exact ? ' psa-stat-exact' : ''}">${s.key} ${escapeHtml(s.text)}</span>`)
        .join('')}</div>`
    : '';
  const moveText = card.moves
    .map((m) => {
      const pp = card.movePp?.[m];
      return pp?.cur != null ? `${m} (${pp.cur}/${pp.max})` : m;
    })
    .join(' · ');
  const movesHtml = moveText
    ? escapeHtml(moveText) +
      (card.hiddenCount > 0 ? ` <span class="psa-hidden">(+${card.hiddenCount} hidden)</span>` : '')
    : '<span class="psa-muted">no moves revealed</span>';
  const potentialHtml = card.potential?.length
    ? `<div class="psa-potential">could have: ${escapeHtml(card.potential.join(' · '))}</div>`
    : '';
  // Predicted-damage comparison vs their active — the same matchupDamage
  // figures as the matchup's Damage row, one line per switch candidate.
  const vsHtml = card.vsActive
    ? (() => {
        const parts = [];
        const t = card.vsActive.takes;
        if (t?.move) {
          const p = Math.round(t.pct);
          const cls = p >= 100 ? 'psa-card-vs-danger' : p >= 50 ? 'psa-card-vs-warn' : '';
          parts.push(`<span class="${cls}">takes ~${p}% (${escapeHtml(t.move)})</span>`);
        } else {
          parts.push('<span class="psa-muted">no revealed damage in</span>');
        }
        if (card.vsActive.deals) {
          const p = Math.round(card.vsActive.deals.pct);
          parts.push(`<span class="${p >= 50 ? 'psa-card-vs-good' : ''}">deals ~${p}% (${escapeHtml(card.vsActive.deals.move)})</span>`);
        }
        if (card.vsActive.hidden) {
          parts.push(`<span class="psa-muted">could take ~${Math.round(card.vsActive.hidden.pct)}% (${escapeHtml(card.vsActive.hidden.move)})</span>`);
        }
        return `<div class="psa-card-vs" title="Predicted damage if you switch ${escapeHtml(card.species)} in against their ${escapeHtml(card.vsActive.species)} (same calc as the recommendations)">vs ${escapeHtml(card.vsActive.species)}: ${parts.join(' · ')}</div>`;
      })()
    : '';

  return `<div class="psa-card${card.active ? ' psa-active' : ''}${card.fainted ? ' psa-fainted' : ''}${card.preview ? ' psa-preview' : ''}" title="${escapeHtml(card.ident)}">
  <div class="psa-card-head">
    <span class="psa-species">${escapeHtml(card.species)}</span>
    ${card.preview ? '<span class="psa-tag" title="Known from team preview — details appear as it is revealed">preview</span>' : ''}
    ${card.active ? '<span class="psa-tag psa-tag-active">on field</span>' : ''}
    ${card.fainted ? '<span class="psa-tag psa-tag-fainted">fainted</span>' : ''}
    ${card.observed ? '<span class="psa-tag psa-tag-observed" title="Read from a hover tooltip">👁</span>' : ''}
    ${card.status ? `<span class="psa-status psa-status-${escapeHtml(card.status)}">${escapeHtml(STATUS_LABELS[card.status] ?? card.status)}</span>` : ''}
  </div>
  ${hpBar(card.hpPercent)}
  <div class="psa-card-hp">${card.hpPercent != null ? `${card.hpPercent}%` : '<span class="psa-muted">??</span>'}</div>
  ${statsHtml}
  ${vsHtml}
  <div class="psa-card-moves">${movesHtml}</div>
  ${potentialHtml}
  <div class="psa-card-details">${escapeHtml(details)}</div>
  ${evHtml}
  ${boostsText ? `<div class="psa-boosts">${escapeHtml(boostsText)}</div>` : ''}
</div>`;
}

function renderEmptySlot(slot) {
  return `<div class="psa-card psa-slot-empty" title="Not revealed yet">
  <div class="psa-card-head"><span class="psa-species psa-muted">Slot ${slot}</span></div>
  <div class="psa-card-hp psa-muted">?</div>
  <div class="psa-card-moves psa-muted">not revealed yet</div>
</div>`;
}

function renderMatchup(matchup) {
  if (!matchup) return '';
  const statOf = (card, key) => card.stats?.find((x) => x.key === key) ?? null;
  const statText = (card, key) => statOf(card, key)?.text ?? '—';
  const hpText = (c) => (c.hpPercent != null ? `${c.hpPercent}%` : '??');
  const itemText = (c) => (c.itemKnown ? (c.item ?? 'None') : '?');

  // Certainty-based comparison: green marks the side that *definitely* wins a
  // stat. Ranges only tint when they don't overlap (a 182-245 vs 250-310 Atk
  // is a sure loss, but 182-245 vs 220-280 is a coin flip and stays neutral).
  const winnerOf = (us, them) => {
    if (!us || !them) return '';
    const oMin = us.min, oMax = us.max, tMin = them.min, tMax = them.max;
    if (oMin == null || oMax == null || tMin == null || tMax == null) return '';
    if (oMin > tMax) return 'us';
    if (tMin > oMax) return 'them';
    return '';
  };

  const row = (label, oursText, theirsText, win = '', cls = '') => {
    const usCls = win === 'us' ? 'psa-match-win' : win === 'them' ? 'psa-match-lose' : '';
    const themCls = win === 'them' ? 'psa-match-win' : win === 'us' ? 'psa-match-lose' : '';
    return `<tr class="${cls}"><td>${escapeHtml(label)}</td><td class="psa-match-us-col ${usCls}">${escapeHtml(oursText)}</td><td class="psa-match-them-col ${themCls}">${escapeHtml(theirsText)}</td></tr>`;
  };

  const hpUs = matchup.ours.hpPercent, hpThem = matchup.theirs.hpPercent;
  const hpWin = hpUs != null && hpThem != null ? (hpUs > hpThem ? 'us' : hpThem > hpUs ? 'them' : '') : '';

  // Type-effectiveness row: who hits whom super effectively.
  const seText = (list, limit) => list.slice(0, limit).map((x) => `${x.move} ${x.mult}×`).join(', ');
  let typeUs = '—', typeThem = '—', typeUsCls = 'psa-match-type-none', typeThemCls = 'psa-match-type-none';
  const te = matchup.typeEdge;
  if (te && !te.unknown) {
    if (te.ourSE.length) {
      typeUs = `✚ ${seText(te.ourSE, 4)}`;
      typeUsCls = 'psa-match-se';
    } else {
      typeUs = 'no SE coverage';
    }
    const parts = [];
    if (te.theirSE.length) parts.push(`✚ ${seText(te.theirSE, 4)}`);
    if (te.theirPotentialSE.length) parts.push(`<span class="psa-muted">could: ${seText(te.theirPotentialSE, 3)}</span>`);
    if (parts.length) {
      typeThem = parts.join(' ');
      typeThemCls = 'psa-match-se';
    } else {
      typeThem = 'no SE moves';
    }
  }
  const typeRow = `<tr class="psa-match-row-type"><td title="Type effectiveness: which of your moves hit their types super effectively, and which of theirs (revealed or likely) could hit yours">Type</td><td class="psa-match-us-col ${typeUsCls}" title="Your revealed moves that hit their current types for 2× or more">${typeUs}</td><td class="psa-match-them-col ${typeThemCls}" title="Their revealed moves that hit you super effectively; 'could:' = likely options from their species' learnset that aren't revealed yet">${typeThem}</td></tr>`;

  // Predicted-damage row: each side's best move, with the strongest likely
  // hidden move flagged as 'could:' when it threatens.
  const dmg = matchup.damage;
  const oursDmg = dmg?.ours ?? null;
  const theirsDmg = dmg?.theirs ?? null;
  const theirHidden = dmg?.theirHidden ?? null;
  let dmgUs = '—', dmgThem = '—', dmgUsCls = 'psa-match-type-none', dmgThemCls = 'psa-match-type-none';
  if (oursDmg || theirsDmg) {
    const winner =
      !oursDmg ? 'them' : !theirsDmg ? 'us' : oursDmg.pct > theirsDmg.pct ? 'us' : theirsDmg.pct > oursDmg.pct ? 'them' : '';
    const cellCls = (isUs, pct) => {
      if (pct == null) return 'psa-match-type-none';
      // A potential OHKO reads as a threat, not a stat win — red beats green.
      if (pct >= 100) return 'psa-match-danger';
      const ahead = (isUs && winner === 'us') || (!isUs && winner === 'them');
      return ahead ? 'psa-match-win' : 'psa-match-lose';
    };
    const dmgText = (d) => (d ? `~${Math.round(d.pct)}% ${d.move}` : 'no moves');
    dmgUs = dmgText(oursDmg);
    dmgThem = dmgText(theirsDmg);
    if (theirHidden) dmgThem += ` <span class="psa-muted">(could: ~${Math.round(theirHidden.pct)}% ${theirHidden.move})</span>`;
    dmgUsCls = cellCls(true, oursDmg?.pct ?? null);
    dmgThemCls = cellCls(false, theirsDmg?.pct ?? null);
  }
  const dmgRow = `<tr class="psa-match-row-dmg"><td title="Predicted damage of each side's best revealed move against the other's active (mean roll, same calc as the recommendations); 'could:' = a likely hidden move that hits harder">Damage</td><td class="psa-match-us-col ${dmgUsCls}" title="${oursDmg ? `${oursDmg.min}-${oursDmg.max}% roll` : ''}">${dmgUs}</td><td class="psa-match-them-col ${dmgThemCls}" title="${theirsDmg ? `${theirsDmg.min}-${theirsDmg.max}% roll` : ''}">${dmgThem}</td></tr>`;

  return `<div class="psa-matchup">
  <div class="psa-match-head">
    <span class="psa-match-name">${escapeHtml(matchup.ours.species)}</span>
    <span class="psa-match-vs">vs</span>
    <span class="psa-match-name">${escapeHtml(matchup.theirs.species)}</span>
    <span class="psa-match-speed" title="Who acts first in this matchup">⚡ ${escapeHtml(matchup.speed)}</span>
  </div>
  <table class="psa-match-table" title="Green = the side that definitely wins this stat (ranges that don't overlap); neutral = too close to call">
    ${row('HP', hpText(matchup.ours), hpText(matchup.theirs), hpWin)}
    ${row('Atk', statText(matchup.ours, 'A'), statText(matchup.theirs, 'A'), winnerOf(statOf(matchup.ours, 'A'), statOf(matchup.theirs, 'A')))}
    ${row('Def', statText(matchup.ours, 'D'), statText(matchup.theirs, 'D'), winnerOf(statOf(matchup.ours, 'D'), statOf(matchup.theirs, 'D')))}
    ${row('SpA', statText(matchup.ours, 'SA'), statText(matchup.theirs, 'SA'), winnerOf(statOf(matchup.ours, 'SA'), statOf(matchup.theirs, 'SA')))}
    ${row('SpD', statText(matchup.ours, 'SD'), statText(matchup.theirs, 'SD'), winnerOf(statOf(matchup.ours, 'SD'), statOf(matchup.theirs, 'SD')))}
    ${row('Spe', statText(matchup.ours, 'S'), statText(matchup.theirs, 'S'), winnerOf(statOf(matchup.ours, 'S'), statOf(matchup.theirs, 'S')), 'psa-match-row-spe')}
    ${dmgRow}
    ${row('Item', itemText(matchup.ours), itemText(matchup.theirs))}
    ${row('Ability', matchup.ours.ability ?? '?', matchup.theirs.ability ?? '?')}
    ${typeRow}
  </table>
</div>`;
}

function renderSide(side, sideClass, label) {
  const slots = side.slots.map((card) => (card.empty ? renderEmptySlot(card) : renderCard(card))).join('');
  return `<section class="psa-side ${sideClass}">
  <h3 class="psa-side-title">${label}${side.name ? ` <span class="psa-name">${escapeHtml(side.name)}</span>` : ''}</h3>
  <div class="psa-slot-grid">${slots || '<div class="psa-muted">no team data yet</div>'}</div>
  ${side.sideEffects.length ? `<div class="psa-sideeffects">${side.sideEffects.map(escapeHtml).join(' · ')}</div>` : ''}
</section>`;
}

export function renderPanel(model) {
  const header = (body) => `<div class="psa-panel" data-panel-version="1" data-opp="${escapeHtml(model.meta?.oppName ?? '')}" data-turn="${model.meta?.turn ?? 0}">
  <div class="psa-header">
    <span class="psa-title">⚡ Battle Assistant</span>
    <span class="psa-meta">${escapeHtml([model.meta?.format, model.meta?.gametype, `Turn ${model.meta?.turn ?? 0}`].filter(Boolean).join(' · '))}</span>
    <button class="psa-collapse" type="button" title="Collapse / expand">−</button>
  </div>
  <div class="psa-body">${body}</div>
</div>`;

  if (model.empty) {
    return header('<div class="psa-empty">No battle data yet — waiting for a battle…</div>');
  }

  const rec = model.recommendation;
  const winnerText = model.meta?.winner
    ? model.meta.winner === 'tie'
      ? 'Tie game'
      : `${model.meta.winner} wins`
    : null;

  const confBadge = (c) => (c != null ? ` <span class="psa-rec-conf" title="How strongly this option is preferred over its alternative">${c}%</span>` : '');
  const recHtml = `<div class="psa-rec">
  <div class="psa-rec-row"><span class="psa-rec-label">Best move</span><span class="psa-rec-value">${escapeHtml(rec?.bestMove?.move ?? '—')}${confBadge(rec?.bestMove?.confidence)}</span></div>
  <div class="psa-rec-row"><span class="psa-rec-label">Switch to</span><span class="psa-rec-value">${escapeHtml(rec?.switchTo?.species ?? '—')}${confBadge(rec?.switchTo?.confidence)}</span></div>
  ${rec?.note ? `<div class="psa-rec-note">${escapeHtml(rec.note)}</div>` : ''}
  ${winnerText ? `<div class="psa-rec-note psa-winner">${escapeHtml(winnerText)}</div>` : ''}
  ${(rec?.reasoning ?? []).length ? `<ul class="psa-reasoning">${rec.reasoning.map((r) => `<li>${escapeHtml(r)}</li>`).join('')}</ul>` : ''}
</div>`;

  const logHtml = model.recentActions.length
    ? `<details class="psa-log"><summary>Recent actions</summary><ol>${model.recentActions
        .map((a) => `<li><span class="psa-log-turn">T${a.turn}</span> ${escapeHtml(a.text)}</li>`)
        .join('')}</ol></details>`
    : '';

  const profileHtml = model.profile
    ? `<div class="psa-profile">
  <span>vs <strong>${escapeHtml(model.profile.opponent ?? '?')}</strong></span>
  ${model.profile.battles ? `<span>${model.profile.battles} battle${model.profile.battles === 1 ? '' : 's'}</span>` : ''}
  ${model.profile.recordText ? `<span>record ${escapeHtml(model.profile.recordText)}</span>` : ''}
  ${model.profile.commonLead ? `<span>lead ${escapeHtml(model.profile.commonLead.species)} ${model.profile.commonLead.pct}%</span>` : ''}
  ${model.profile.lowHpSwitchRate != null ? `<span>switches when low ${model.profile.lowHpSwitchRate}%</span>` : ''}
</div>`
    : '';

  const captureText = model.capture.active
    ? `● capturing screen${model.capture.frames ? ` · ${model.capture.frames} frames · ${model.capture.changes} changes seen` : ''}`
    : null;
  const watchingHtml = `<div class="psa-watch${model.capture.active ? ' psa-watch-live' : ''}">
  <span class="psa-watch-icon">${model.capture.active ? '●' : '👁'}</span>
  <span class="psa-watch-text">
    ${captureText ? `${captureText} — ` : 'watching your screen — '}${model.watching.count
      ? `hover a Pokémon to read it · read ${model.watching.count} tooltip${model.watching.count === 1 ? '' : 's'}${model.ocrCount ? ` · ${model.ocrCount} via OCR` : ''}${model.watching.last ? ` · last: ${escapeHtml(model.watching.last)}` : ''}`
      : 'hover a Pokémon to read it'}
  </span>
</div>`;

  const body = `
  ${watchingHtml}
  ${recHtml}
  ${renderMatchup(model.matchup)}
  ${profileHtml}
  <div class="psa-field">${escapeHtml(model.field)}</div>
  <div class="psa-columns">
    ${renderSide(model.us, 'psa-side-us', 'You')}
    ${renderSide(model.them, 'psa-side-them', 'Opponent')}
  </div>
  ${logHtml}`;

  return header(body);
}

// Convenience: state -> panel HTML in one call.
export function buildPanelHtml(state, opts = {}) {
  return renderPanel(buildPanelModel(state, opts));
}
