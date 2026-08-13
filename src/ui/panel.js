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

  const sideModel = (side) => {
    const rosterIndex = new Map((side?.roster ?? []).map((r, i) => [r.ident, i]));
    const team = (side?.pokemon ?? [])
      .map((mon) => {
        const boosts = Object.fromEntries(Object.entries(mon.boosts ?? {}).filter(([, v]) => v !== 0));
        return {
          ident: mon.ident,
          species: mon.species,
          nickname: mon.nickname,
          active: !!mon.active,
          fainted: !!mon.fainted,
          hpPercent: mon.hpPercent ?? null,
          status: mon.status ?? null,
          item: mon.item ?? null,
          itemKnown: !!mon.itemRevealed,
          itemConsumed: !!mon.itemConsumed,
          ability: mon.ability ?? null,
          tera: mon.teraType ?? null,
          moves: [...(mon.moves ?? [])],
          hiddenCount: Math.max(0, 4 - (mon.moves?.length ?? 0)),
          boosts,
          switchCount: mon.switchCount ?? 0,
        };
      })
      .sort((a, b) => {
        if (a.active !== b.active) return a.active ? -1 : 1;
        if (a.fainted !== b.fainted) return a.fainted ? 1 : -1;
        return (rosterIndex.get(a.ident) ?? 99) - (rosterIndex.get(b.ident) ?? 99);
      });
    return {
      name: side?.playerName ?? null,
      team,
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
    us: sideModel(ourSide),
    them: sideModel(theirSide),
    recommendation: opts.recommendation ?? null,
    profile: opts.profile ?? null,
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
  const details = `item: ${itemText} · ability: ${card.ability ?? '?'}${card.tera ? ` · tera: ${card.tera}` : ''}`;
  const movesHtml = card.moves.length
    ? escapeHtml(card.moves.join(' · ')) +
      (card.hiddenCount > 0 ? ` <span class="psa-hidden">(+${card.hiddenCount} hidden)</span>` : '')
    : '<span class="psa-muted">no moves revealed</span>';

  return `<div class="psa-card${card.active ? ' psa-active' : ''}${card.fainted ? ' psa-fainted' : ''}" title="${escapeHtml(card.ident)}">
  <div class="psa-card-head">
    <span class="psa-species">${escapeHtml(card.species)}</span>
    ${card.active ? '<span class="psa-tag psa-tag-active">on field</span>' : ''}
    ${card.fainted ? '<span class="psa-tag psa-tag-fainted">fainted</span>' : ''}
    ${card.status ? `<span class="psa-status psa-status-${escapeHtml(card.status)}">${escapeHtml(STATUS_LABELS[card.status] ?? card.status)}</span>` : ''}
  </div>
  ${hpBar(card.hpPercent)}
  <div class="psa-card-hp">${card.hpPercent != null ? `${card.hpPercent}%` : '<span class="psa-muted">??</span>'}</div>
  <div class="psa-card-moves">${movesHtml}</div>
  <div class="psa-card-details">${escapeHtml(details)}</div>
  ${boostsText ? `<div class="psa-boosts">${escapeHtml(boostsText)}</div>` : ''}
</div>`;
}

function renderSide(side, sideClass, label) {
  const active = side.team.filter((m) => m.active).map(renderCard);
  const bench = side.team.filter((m) => !m.active).map(renderCard);
  return `<section class="psa-side ${sideClass}">
  <h3 class="psa-side-title">${label}${side.name ? ` <span class="psa-name">${escapeHtml(side.name)}</span>` : ''}</h3>
  <div class="psa-active-zone">${active.join('') || '<div class="psa-muted">no active Pokémon</div>'}</div>
  <div class="psa-bench">${bench.join('')}</div>
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

  const body = `
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
