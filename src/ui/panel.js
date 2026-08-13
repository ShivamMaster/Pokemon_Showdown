// src/ui/panel.js
// Pure UI layer for the battle assistant panel.
//
// buildPanelModel(state, opts) turns a reader BattleState into a plain display
// model. renderPanel(model) renders that model to an HTML string.
//
// No DOM access anywhere in this file, so it runs identically in Node (tests)
// and in the browser (extension content script + demo page). The engine will
// plug into the recommendation slot later via opts.recommendation.

const STATUS_LABELS = {
  brn: 'Burn',
  par: 'Paralysis',
  slp: 'Sleep',
  frz: 'Frozen',
  psn: 'Poison',
  tox: 'Toxic',
};

export function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[c]));
}

// ---------------------------------------------------------------------------
// Display model
// ---------------------------------------------------------------------------

export function buildPanelModel(state, opts = {}) {
  const ourSideId = opts.ourSideId ?? 'p1';
  const ourSide = state?.sides?.[ourSideId] ?? null;
  const theirSide = ourSideId === 'p1' ? state?.sides?.p2 ?? null : state?.sides?.p1 ?? null;

  const empty = !(ourSide?.pokemon?.length || theirSide?.pokemon?.length);

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

  const cardOf = (mon, showPotential) => {
    const boosts = Object.fromEntries(Object.entries(mon.boosts ?? {}).filter(([, v]) => v !== 0));
    const hidden = Math.max(0, 4 - (mon.moves?.length ?? 0));
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
      boosts,
      switchCount: mon.switchCount ?? 0,
      potential:
        showPotential && hidden > 0 && getPotential ? (getPotential(mon.species) ?? []).slice(0, 3) : [],
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
  const sideModel = (side, { showPotential } = {}) => {
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
        slots.push(cardOf(mon, showPotential));
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
    us: sideModel(ourSide, { showPotential: false }),
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

  const recHtml = `<div class="psa-rec">
  <div class="psa-rec-row"><span class="psa-rec-label">Best move</span><strong class="psa-rec-value">${escapeHtml(rec?.bestMove?.move ?? '—')}</strong></div>
  <div class="psa-rec-row"><span class="psa-rec-label">Switch to</span><strong class="psa-rec-value">${escapeHtml(rec?.switchTo?.species ?? '—')}</strong></div>
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
